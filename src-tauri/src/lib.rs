use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::process::{Child, Command};
use std::net::TcpListener;

mod config;
mod delta;
mod comm;

/// 服务器状态
pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub port: u16,
}

// ============ 常量 ============

const NODE_VERSION: &str = "22.18.0";
// 国内镜像（首次下载快）
const NODE_MIRROR: &str = "https://cdn.npmmirror.com/binaries/node";

// ============ 启动页（独立 splash 窗口） ============

// 编译时嵌入 splash.html 内容
const SPLASH_HTML: &str = include_str!("../splash.html");
// 编译时嵌入应用图标
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

/// 创建 splash 窗口，通过自定义协议 splashpage:// 加载内嵌的 HTML
fn create_splash_window(handle: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    #[cfg(target_os = "windows")]
    let splash_url_str = "http://splashpage.localhost";
    #[cfg(not(target_os = "windows"))]
    let splash_url_str = "splashpage://localhost";

    let url: tauri::Url = match splash_url_str.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[XdesinHMI] Failed to parse splash URL: {}", e);
            return None;
        }
    };

    match WebviewWindowBuilder::new(handle, "splash", WebviewUrl::External(url))
        .title("")
        .inner_size(480.0, 320.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .center()
        .visible(false) // 先隐藏，等页面加载完再显示，避免黑屏闪烁
        .build()
    {
        Ok(w) => {
            println!("[XdesinHMI] Splash window created (hidden until page loaded)");
            Some(w)
        }
        Err(e) => {
            eprintln!("[XdesinHMI] Failed to create splash window: {}", e);
            None
        }
    }
}

/// 读取应用主题设置（从 config.json）
fn read_app_theme(app: &tauri::AppHandle) -> String {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("config.json");
        if p.exists() {
            if let Ok(content) = std::fs::read_to_string(&p) {
                if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(theme) = cfg.pointer("/app/theme").and_then(|v| v.as_str()) {
                        return theme.to_string();
                    }
                }
            }
        }
    }
    "light".to_string()
}

/// 将主题设置应用到 splash 窗口
fn apply_splash_theme(app: &tauri::AppHandle) {
    let theme = read_app_theme(app);
    if theme == "light" || theme == "dark" {
        if let Some(w) = app.get_webview_window("splash") {
            let js = format!("document.documentElement.setAttribute('data-theme','{}')", theme);
            let _ = w.eval(&js);
        }
    }
}

// ============ 平台辅助 ============

/// 启动日志文件路径（懒初始化）
static STARTUP_LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// 初始化启动日志文件路径（需要 AppHandle，仅调用一次）
fn init_startup_log(app: &tauri::AppHandle) {
    let data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&data_dir).ok();
    STARTUP_LOG_PATH.set(data_dir.join("xdesinhmi-startup.log")).ok();
}

/// 写入启动日志（append，带时间戳）
pub fn startup_log(msg: &str) {
    println!("[XdesinHMI] {}", msg);
    if let Some(path) = STARTUP_LOG_PATH.get() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let secs = (timestamp % 86400) / 3600;
        let mins = (timestamp % 3600) / 60;
        let secs_r = timestamp % 60;
        let line = format!("[{:02}:{:02}:{:02}] {}\n", secs, mins, secs_r, msg);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[allow(dead_code)]
fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn path_separator() -> &'static str {
    if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    }
}

fn curl_cmd() -> &'static str {
    if cfg!(target_os = "windows") {
        "curl.exe"
    } else {
        "curl"
    }
}

/// 创建隐藏窗口的子进程（Windows 不弹出控制台窗口）
#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

// ============ 工具函数 ============

fn find_available_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("Failed to bind to find available port")
        .local_addr()
        .expect("Failed to get local addr")
        .port()
}

pub fn wait_for_server(port: u16) {
    for i in 0..300 {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            startup_log(&format!("Server ready at http://127.0.0.1:{}", port));
            return;
        }
        if i > 0 && i % 50 == 0 {
            startup_log(&format!("Waiting for server... ({}s)", i / 10));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    startup_log("WARNING: Server did not start within 30s");
}

/// 更新启动页状态
fn splash_update(app: &tauri::AppHandle, status: &str, progress: i32, detail: &str) {
    if let Some(window) = app.get_webview_window("splash") {
        let js = format!(
            "window.__splashUpdate && window.__splashUpdate({{status:'{}',progress:{},detail:'{}'}})",
            status.replace('\'', "\\'"),
            progress,
            detail.replace('\'', "\\'")
        );
        let _ = window.eval(&js);
    }
}

/// 更新启动页检查项状态
fn splash_check(app: &tauri::AppHandle, item: &str, state: &str) {
    if let Some(window) = app.get_webview_window("splash") {
        let js = format!(
            "window.__splashUpdate && window.__splashUpdate({{check{}:'{}'}})",
            item, state
        );
        let _ = window.eval(&js);
    }
}

/// 显示启动页错误
fn splash_error(app: &tauri::AppHandle, msg: &str) {
    if let Some(window) = app.get_webview_window("splash") {
        let js = format!(
            "window.__splashUpdate && window.__splashUpdate({{status:'❌ {}',error:true}})",
            msg.replace('\'', "\\'")
        );
        let _ = window.eval(&js);
    }
}

// ============ 运行时管理 ============

/// 获取运行时存储目录 ({app_data_dir}/runtimes/)
fn runtimes_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let dir = data_dir.join("runtimes");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 查找 Node 二进制路径
fn find_node(app: &tauri::AppHandle) -> Option<String> {
    let rd = runtimes_dir(app);
    let bundled = if cfg!(target_os = "windows") {
        rd.join("node").join("node.exe")
    } else {
        rd.join("node").join("bin").join("node")
    };
    if bundled.exists() {
        if verify_node(&bundled.to_string_lossy()) {
            startup_log(&format!("Found runtime Node: {}", bundled.display()));
            return Some(bundled.to_string_lossy().to_string());
        } else {
            startup_log(&format!(
                "Runtime Node exists but broken, removing: {}",
                bundled.display()
            ));
            std::fs::remove_dir_all(rd.join("node")).ok();
        }
    }
    which_node()
}

fn which_node() -> Option<String> {
    let cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Ok(output) = hidden_command(cmd).arg("node").output() {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let path = line.trim().to_string();
                if !path.is_empty() && verify_node(&path) {
                    startup_log(&format!("Found system Node: {} ({})", path, node_version(&path)));
                    return Some(path);
                }
            }
        }
    }
    // 手动扫描 PATH 目录
    if let Some(path) = find_in_path("node") {
        if verify_node(&path) {
            startup_log(&format!("Found system Node via PATH scan: {} ({})", path, node_version(&path)));
            return Some(path);
        }
    }
    // 常见路径 fallback
    if cfg!(target_os = "windows") {
        let mut paths: Vec<String> = Vec::new();
        if let Ok(pf) = std::env::var("PROGRAMFILES") {
            paths.push(format!("{}\\nodejs\\node.exe", pf));
        }
        if let Ok(pf86) = std::env::var("PROGRAMFILES(X86)") {
            paths.push(format!("{}\\nodejs\\node.exe", pf86));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let nvm_dir = std::path::Path::new(&appdata).join("nvm");
            if nvm_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    for entry in entries.flatten() {
                        let node_path = entry.path().join("node.exe");
                        if node_path.exists() {
                            paths.push(node_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        for path in &paths {
            if std::path::Path::new(path).exists() && verify_node(path) {
                startup_log(&format!("Found system Node at Windows fallback: {}", path));
                return Some(path.clone());
            }
        }
    } else {
        for path in &["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
            if std::path::Path::new(path).exists() && verify_node(path) {
                startup_log(&format!("Found system Node at fallback: {}", path));
                return Some(path.to_string());
            }
        }
    }
    None
}

/// 手动在 PATH 中查找可执行文件（不依赖 where/which 子进程）
fn find_in_path(bin_name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    for dir in path_var.split(sep) {
        if dir.is_empty() {
            continue;
        }
        let candidate = if cfg!(target_os = "windows") {
            std::path::Path::new(dir).join(format!("{}.exe", bin_name))
        } else {
            std::path::Path::new(dir).join(bin_name)
        };
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// 验证 node 二进制是否可用（node -v）
fn verify_node(node_path: &str) -> bool {
    match hidden_command(node_path).arg("-v").output() {
        Ok(output) => {
            let ok = output.status.success();
            if !ok {
                startup_log(&format!(
                    "Node verification failed for {}: exit code {:?}",
                    node_path,
                    output.status.code()
                ));
            }
            ok
        }
        Err(e) => {
            startup_log(&format!("Node verification error for {}: {}", node_path, e));
            false
        }
    }
}

/// 获取 node 版本号
fn node_version(node_path: &str) -> String {
    match hidden_command(node_path).arg("-v").output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        _ => "unknown".into(),
    }
}

/// 构建 Node 下载 URL
fn node_download_url() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    if cfg!(target_os = "windows") {
        format!("{}/v{}/node-v{}-win-{}.zip", NODE_MIRROR, NODE_VERSION, NODE_VERSION, arch)
    } else if cfg!(target_os = "macos") {
        format!("{}/v{}/node-v{}-darwin-{}.tar.gz", NODE_MIRROR, NODE_VERSION, NODE_VERSION, arch)
    } else {
        format!("{}/v{}/node-v{}-linux-{}.tar.xz", NODE_MIRROR, NODE_VERSION, NODE_VERSION, arch)
    }
}

/// 构建 curl 下载命令
fn curl_download_cmd(program: &str) -> Command {
    let mut cmd = hidden_command(program);
    cmd.args(&["-L", "-f", "--progress-bar", "--connect-timeout", "30", "--max-time", "300"]);
    #[cfg(target_os = "windows")]
    cmd.arg("--ssl-no-revoke");
    cmd
}

/// 构建 curl HEAD 请求命令
fn curl_head_cmd(program: &str) -> Command {
    let mut cmd = hidden_command(program);
    cmd.args(&["-sI", "-L", "--connect-timeout", "10", "--max-time", "15"]);
    #[cfg(target_os = "windows")]
    cmd.arg("--ssl-no-revoke");
    cmd
}

/// 获取文件大小（Content-Length）
fn get_remote_size(url: &str) -> u64 {
    let curl = curl_cmd();
    let mut cmd = curl_head_cmd(curl);
    cmd.arg(url);
    for key in &["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            let headers = String::from_utf8_lossy(&out.stdout);
            for line in headers.lines() {
                if line.to_lowercase().starts_with("content-length:") {
                    if let Ok(size) = line.split(':').nth(1).unwrap_or("0").trim().parse::<u64>() {
                        return size;
                    }
                }
            }
        }
        _ => {}
    }
    0
}

/// 下载并解压运行时
fn download_runtime(app: &tauri::AppHandle, name: &str, label: &str, url: &str) -> Result<(), String> {
    let rd = runtimes_dir(app);
    let target_dir = rd.join(name);

    let check_bin = if cfg!(target_os = "windows") {
        target_dir.join("node.exe")
    } else {
        target_dir.join("bin").join("node")
    };
    if check_bin.exists() {
        println!("[XdesinHMI] {} already exists, skip download", label);
        return Ok(());
    }

    let temp_dir = std::env::temp_dir().join(format!("xdesinhmi-dl-{}", name));
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let curl_check = hidden_command(curl_cmd())
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if curl_check.is_err() || !curl_check.unwrap().success() {
        return Err(format!("未找到 curl，无法下载 {}。请确认系统已安装 curl", label));
    }
    let archive_ext = if url.ends_with(".zip") {
        ".zip"
    } else if url.ends_with(".tar.xz") {
        ".tar.xz"
    } else {
        ".tar.gz"
    };
    let archive = temp_dir.join(format!("download{}", archive_ext));

    let total = get_remote_size(url);
    let total_mb = total as f64 / 1024.0 / 1024.0;
    println!("[XdesinHMI] Downloading {} from {} ({:.1} MB)", label, url, total_mb);

    splash_update(app, &format!("正在下载 {}...", label), 0, &format!("{:.1} MB", total_mb));
    splash_check(app, name, "downloading");

    let curl = curl_cmd();
    let mut cmd = curl_download_cmd(curl);
    cmd.arg("-o")
        .arg(&archive)
        .arg(url)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null());

    for key in &["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "ALL_PROXY", "all_proxy"] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("curl 启动失败: {}", e))?;

    let start = std::time::Instant::now();
    let download_timeout = std::time::Duration::from_secs(300);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let stderr_msg = match child.wait_with_output() {
                        Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
                        Err(_) => String::new(),
                    };
                    let err_detail = if stderr_msg.is_empty() {
                        format!("退出码: {:?}", status.code())
                    } else {
                        format!("退出码: {:?}, {}", status.code(), stderr_msg)
                    };
                    startup_log(&format!("{} download curl error: {}", label, err_detail));
                    std::fs::remove_file(&archive).ok();
                    return Err(format!("{} 下载失败 ({})", label, err_detail));
                }
                break;
            }
            Ok(None) => {
                if start.elapsed() > download_timeout {
                    let _ = child.kill();
                    std::fs::remove_file(&archive).ok();
                    return Err(format!("{} 下载超时（5分钟无响应）", label));
                }
                let downloaded = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
                let progress = if total > 0 {
                    (downloaded as f64 / total as f64 * 100.0) as i32
                } else {
                    0
                };
                let elapsed = start.elapsed().as_secs_f64();
                let speed_mb = if elapsed > 0.0 { downloaded as f64 / elapsed / 1024.0 / 1024.0 } else { 0.0 };
                let dl_mb = downloaded as f64 / 1024.0 / 1024.0;
                splash_update(
                    app,
                    &format!("正在下载 {}...", label),
                    progress,
                    &format!("{:.1} / {:.1} MB  ({:.1} MB/s)", dl_mb, total_mb, speed_mb),
                );
            }
            Err(e) => return Err(format!("下载进程异常: {}", e)),
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    // 解压
    splash_update(app, &format!("正在解压 {}...", label), 100, "请稍候...");
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let strip = 1;
    let extract_status = if url.ends_with(".tar.xz") {
        let mut cmd = hidden_command("tar");
        cmd.args(&["-xJf", archive.to_str().unwrap_or("")]);
        cmd.arg(format!("--strip-components={}", strip));
        cmd.arg("-C").arg(&target_dir).status().map_err(|e| format!("解压失败: {}", e))?
    } else {
        let mut cmd = hidden_command("tar");
        cmd.args(&["-xf", archive.to_str().unwrap_or("")]);
        cmd.arg(format!("--strip-components={}", strip));
        cmd.arg("-C").arg(&target_dir).status().map_err(|e| format!("解压失败: {}", e))?
    };

    if !extract_status.success() {
        std::fs::remove_dir_all(&target_dir).ok();
        return Err(format!("{} 解压失败", label));
    }

    // 设置权限（仅 Unix）
    #[cfg(unix)]
    {
        let bin = target_dir.join("bin").join("node");
        std::process::Command::new("chmod").args(&["+x", bin.to_str().unwrap_or("")]).status().ok();
    }

    std::fs::remove_dir_all(&temp_dir).ok();

    splash_check(app, name, "ok");
    println!("[XdesinHMI] {} installed successfully", label);
    Ok(())
}

// ============ 启动服务器 ============

/// 去除 Windows 扩展路径前缀 \\?\（Node.js 不兼容此格式）
fn clean_windows_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    if cfg!(target_os = "windows") {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    } else {
        s
    }
}

/// 启动 server 进程的核心逻辑（供 delta::restart_server 复用）
pub fn start_server_process(app: &tauri::AppHandle) -> (Child, u16) {
    let port = find_available_port();
    let resource_dir = app.path().resource_dir().expect("Failed to get resource dir");

    // 启动时清理上次热更新残留的备份和临时目录
    let backup_dir = resource_dir.join("server.bak");
    if backup_dir.exists() {
        startup_log("Cleaning up leftover server.bak from previous update");
        let _ = std::fs::remove_dir_all(&backup_dir);
    }
    let patch_tmp = resource_dir.join("server-patch-tmp");
    if patch_tmp.exists() {
        let _ = std::fs::remove_dir_all(&patch_tmp);
    }

    let server_js = resource_dir.join("server").join("server.js");
    let data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    std::fs::create_dir_all(&data_dir).ok();

    let node_bin = find_node(app).unwrap_or_else(|| "node".into());
    let node_dir = std::path::Path::new(&node_bin)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();

    let mut path_parts = vec![];
    if !node_dir.is_empty() && !current_path.contains(&node_dir) {
        path_parts.push(node_dir);
    }

    let sep = path_separator();
    let enhanced_path = if path_parts.is_empty() {
        current_path
    } else {
        format!("{}{}{}", path_parts.join(sep), sep, current_path)
    };

    startup_log(&format!(
        "Starting server: node {} (port={})",
        clean_windows_path(&server_js),
        port
    ));

    let server_dir = clean_windows_path(&resource_dir.join("server"));
    let mut cmd = hidden_command(&node_bin);
    cmd.arg(clean_windows_path(&server_js))
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("XDESIN_DATA_DIR", clean_windows_path(&data_dir))
        .env("PATH", &enhanced_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .current_dir(&server_dir)
        .spawn()
        .expect("Failed to start Next.js server");

    // 将 Node 进程的 stderr 输出到启动日志
    if let Some(stderr) = child.stderr.take() {
        let log_path = STARTUP_LOG_PATH.get().cloned();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if let Some(p) = &log_path {
                    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(p) {
                        use std::io::Write;
                        let _ = writeln!(f, "[node] {}", line);
                    }
                }
            }
        });
    }

    (child, port)
}

fn start_server(app: &tauri::AppHandle) -> (Child, u16) {
    start_server_process(app)
}

// ============ Tauri Commands ============

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.open_devtools();
    }
}

#[tauri::command]
fn write_log(message: String) {
    startup_log(&message);
}

/// 前端调用：将二进制数据写入指定路径（配合 dialog 插件使用）
#[tauri::command]
fn save_file_content(path: String, content: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 前端调用：更新 splash 进度（用于前端接管 80-100% 进度段）
#[tauri::command]
async fn update_splash(app: tauri::AppHandle, status: String, progress: i32, detail: String) {
    splash_update(&app, &status, progress, &detail);
}

/// splash 重试按钮调用：重新执行启动流程
#[tauri::command]
fn retry_startup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        run_production_startup(&app);
    });
}

#[tauri::command]
fn get_server_url(state: tauri::State<ServerState>) -> String {
    format!("http://127.0.0.1:{}", state.port)
}

#[tauri::command]
fn navigate_to(path: String, state: tauri::State<ServerState>, app: tauri::AppHandle) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}{}", state.port, path);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(url.parse().map_err(|e| format!("Invalid URL: {}", e))?);
        Ok(())
    } else {
        Err("Window not found".into())
    }
}

/// 前端页面渲染完成后调用，关闭 splash 并显示主窗口
#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    println!("[XdesinHMI] Frontend signaled ready");
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 生产模式启动流程：检查/下载运行时 → 启动服务 → 导航主窗口
fn run_production_startup(handle: &tauri::AppHandle) {
    init_startup_log(handle);
    startup_log("=== XdesinHMI startup ===");
    startup_log(&format!("Platform: {}-{}", platform_name(), std::env::consts::ARCH));

    splash_update(handle, "正在检查环境...", 20, "");

    let node_present = find_node(handle).is_some();
    startup_log(&format!("Node.js present: {}", node_present));
    if !node_present {
        splash_update(handle, "正在准备运行环境...", 30, "首次启动需要下载，请稍候");
        startup_log(&format!("Downloading Node.js from: {}", node_download_url()));
        match download_runtime(handle, "node", "Node.js", &node_download_url()) {
            Ok(_) => {
                startup_log("Node.js download OK");
            }
            Err(e) => {
                startup_log(&format!("Node.js download failed: {}, trying system node...", e));
                if find_node(handle).is_none() {
                    startup_log("FATAL: No Node.js available (download failed, system not found)");
                    splash_error(handle, "Node.js 下载失败，请检查网络或手动安装 Node.js 后重试");
                    return;
                }
                startup_log("Fallback to system Node.js OK");
            }
        }
    }

    startup_log("All runtimes ready");
    splash_update(handle, "环境就绪", 70, "");
    splash_update(handle, "正在启动服务...", 75, "");

    let (child, port) = start_server(handle);

    if let Some(state) = handle.try_state::<ServerState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(old) = guard.as_mut() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *guard = Some(child);
        }
    } else {
        handle.manage(ServerState {
            child: Mutex::new(Some(child)),
            port,
        });
    }

    wait_for_server(port);

    splash_update(handle, "即将就绪...", 80, "");
    if let Some(main) = handle.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{}", port);
        let _ = main.navigate(url.parse().unwrap());
    }
    finalize_launch(handle, 15);
}

/// 等待前端 app_ready 信号或超时后强制切换
fn finalize_launch(handle: &tauri::AppHandle, timeout_secs: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if handle.get_webview_window("splash").is_none() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    println!("[XdesinHMI] finalize_launch timeout, forcing transition");
    if let Some(splash) = handle.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

// ============ 主入口 ============

pub fn run() {
    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msSmartScreenProtection",
        );
    }

    let is_dev = cfg!(debug_assertions);
    let remote_url = std::env::var("XDESIN_REMOTE_URL").ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        // 注册自定义协议 splashpage:// 用于提供嵌入的 splash HTML
        .register_uri_scheme_protocol("splashpage", |_ctx, request| {
            let path = request.uri().path();
            if path.contains("icon") && path.ends_with(".png") {
                return tauri::http::Response::builder()
                    .status(200)
                    .header("content-type", "image/png")
                    .body(APP_ICON_PNG.to_vec())
                    .unwrap();
            }
            tauri::http::Response::builder()
                .status(200)
                .header("content-type", "text/html; charset=utf-8")
                .body(SPLASH_HTML.as_bytes().to_vec())
                .unwrap()
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "splash" {
                if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                    let _ = webview.window().show();
                    println!("[XdesinHMI] Splash page loaded, window shown");
                }
            }
        })
        .manage(comm::CommManager::new())
        .manage(comm::bluetooth::ForceManager::new())
        .setup(move |app| {
            // Windows: 移除原生标题栏，使用前端模拟红绿灯按钮
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            // 初始化配置管理器
            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            app.manage(config::ConfigManager::new(app_data_dir));

            // 关闭行为：根据配置决定是隐藏到托盘还是直接关闭
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle: tauri::AppHandle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let close_to_tray = app_handle
                            .state::<config::ConfigManager>()
                            .get_close_to_tray();
                        if close_to_tray {
                            api.prevent_close();
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                });
            }

            if let Some(ref url) = remote_url {
                // ---- 远程模式 ----
                println!("[XdesinHMI] Remote mode — connecting to {}", url);
                app.manage(ServerState {
                    child: Mutex::new(None),
                    port: 0,
                });
                let remote = url.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(remote.parse().unwrap());
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            } else {
                // ---- 开发模式 / 生产模式：动态创建 splash 窗口 ----
                let handle = app.handle().clone();

                create_splash_window(&handle);

                std::thread::sleep(std::time::Duration::from_millis(200));
                apply_splash_theme(&handle);

                if is_dev {
                    // ---- 开发模式 ----
                    println!("[XdesinHMI] Dev mode");
                    app.manage(ServerState {
                        child: Mutex::new(None),
                        port: 3200,
                    });

                    #[cfg(debug_assertions)]
                    if let Some(main) = app.get_webview_window("main") {
                        main.open_devtools();
                    }

                    let h = handle.clone();
                    std::thread::spawn(move || {
                        splash_update(&h, "正在连接服务...", 30, "");
                        wait_for_server(3200);
                        splash_update(&h, "即将就绪...", 100, "");
                        if let Some(main) = h.get_webview_window("main") {
                            let _ = main.navigate("http://localhost:3200".parse().unwrap());
                        }
                        finalize_launch(&h, 15);
                    });
                } else {
                    // ---- 生产模式：下载运行时 → 启动服务 ----
                    println!("[XdesinHMI] Production mode");
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        run_production_startup(&handle);
                    });
                }
            }

            // 设置 CommManager 的 AppHandle
            app.state::<comm::CommManager>().set_app_handle(app.handle().clone());

            setup_tray(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            get_server_url, navigate_to, app_ready, save_file_content,
            retry_startup, update_splash, flash_tray_icon,
            open_devtools, write_log,
            config::get_app_config, config::set_app_config,
            delta::apply_server_patch, delta::get_current_server_version, delta::fetch_url, delta::download_file,
            delta::restart_server, delta::verify_file_hash,
            comm::device_connect, comm::device_disconnect, comm::device_get_state,
            comm::device_estop, comm::device_info_get, comm::device_send_raw,
            comm::device_get_debug_log,
            comm::debug_set, comm::plain_mode_set,
            comm::set_report, comm::set_push_pulses_per_mm, comm::set_level_ratio,
            comm::net_getcfg, comm::net_setcfg, comm::net_reset,
            comm::pedal_select, comm::pedal_start, comm::pedal_stop,
            comm::pedal_setload, comm::pedal_level,
            comm::pedal_push_start, comm::pedal_push_stop, comm::pedal_set,
            comm::pedal_zero, comm::pedal_clear, comm::pedal_record,
            comm::motor_enable, comm::motor_disable, comm::motor_stop_all,
            comm::motor_move, comm::motor_moveabs, comm::motor_home,
            comm::motor_stop, comm::motor_zero,
            comm::steer_start, comm::steer_stop,
            comm::force_commands::force_scan,
            comm::force_commands::force_connect,
            comm::force_commands::force_disconnect,
            comm::force_commands::force_zero,
            comm::force_commands::force_calibrate,
            comm::force_commands::force_reset_max,
            comm::force_commands::force_get_state,
            comm::force_commands::force_send_raw,
            comm::force_commands::force_raw_monitor,
            comm::force_commands::force_switch_control,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<ServerState>() {
                        if let Ok(mut guard) = state.child.lock() {
                            if let Some(child) = guard.as_mut() {
                                println!("[XdesinHMI] Killing server process...");
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                            *guard = None;
                        }
                    }
                }
                _ => {
                    // macOS: 点击 Dock 图标时重新显示主窗口
                    #[cfg(target_os = "macos")]
                    if let tauri::RunEvent::Reopen { .. } = event {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            }
        });
}

// ============ 系统托盘 ============

pub struct FlashState(pub Arc<AtomicBool>);

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 XdesinHMI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let flash_state = Arc::new(AtomicBool::new(false));
    let flash_menu = flash_state.clone();
    let flash_click = flash_state.clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("XdesinHMI")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show" => {
                    flash_menu.store(false, Ordering::Relaxed);
                    if let Some(tray) = app.tray_by_id("main-tray") {
                        let _ = tray.set_icon(app.default_window_icon().cloned());
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    flash_click.store(false, Ordering::Relaxed);
                    let app = tray.app_handle();
                    let _ = tray.set_icon(app.default_window_icon().cloned());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    app.manage(FlashState(flash_state));
    Ok(())
}

/// 前端调用：开始托盘图标闪烁
#[tauri::command]
fn flash_tray_icon(app: tauri::AppHandle, state: tauri::State<'_, FlashState>) {
    let flashing = state.0.clone();
    if flashing.load(Ordering::Relaxed) {
        return;
    }
    flashing.store(true, Ordering::Relaxed);

    if app.tray_by_id("main-tray").is_none() {
        flashing.store(false, Ordering::Relaxed);
        return;
    }

    std::thread::spawn(move || {
        let mut show_normal = true;
        while flashing.load(Ordering::Relaxed) {
            show_normal = !show_normal;
            let ah = app.clone();
            let ah2 = app.clone();
            let _ = ah.run_on_main_thread(move || {
                if let Some(tray) = ah2.tray_by_id("main-tray") {
                    if show_normal {
                        let _ = tray.set_icon(ah2.default_window_icon().cloned());
                    } else {
                        let transparent = tauri::image::Image::new_owned(vec![0u8; 32 * 32 * 4], 32, 32);
                        let _ = tray.set_icon(Some(transparent));
                    }
                }
            });
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let ah = app.clone();
        let ah2 = app.clone();
        let _ = ah.run_on_main_thread(move || {
            if let Some(tray) = ah2.tray_by_id("main-tray") {
                let _ = tray.set_icon(ah2.default_window_icon().cloned());
            }
        });
    });
}
