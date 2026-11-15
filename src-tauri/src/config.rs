use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_device")]
    pub device: DeviceConfig,
    #[serde(default = "default_update")]
    pub update: UpdateConfig,
    #[serde(default = "default_app")]
    pub app: AppBehaviorConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    #[serde(default = "default_ip")]
    pub ip: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    #[serde(default = "default_cdn_url")]
    pub cdn_url: String,
    #[serde(default = "default_github_repo")]
    pub github_repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBehaviorConfig {
    #[serde(default)]
    pub close_to_tray: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
}

/// 正式更新源。必须与 lib/config.ts 中的 BUILD_CDN_URL / BUILD_GITHUB_REPO 一致。
const DEFAULT_CDN_URL: &str = "https://o09u11p5v.qnssl.com/hmi";
const DEFAULT_GITHUB_REPO: &str = "ggtiger/hmi01";

/// 早期模板遗留的占位配置。旧安装启动时会把占位值写入 config.json，
/// 仅修改默认值无法修复已落盘的配置，需要在加载时迁移。
const LEGACY_CDN_PREFIX: &str = "https://cdn.example.com";
const LEGACY_GITHUB_REPO: &str = "xdesin/xdesin-hmi";

// 默认值函数
fn default_device() -> DeviceConfig {
    DeviceConfig {
        ip: "192.168.4.1".into(),
        port: 10001,
    }
}
fn default_update() -> UpdateConfig {
    UpdateConfig {
        cdn_url: DEFAULT_CDN_URL.into(),
        github_repo: DEFAULT_GITHUB_REPO.into(),
    }
}
fn default_app() -> AppBehaviorConfig {
    AppBehaviorConfig {
        close_to_tray: false,
        theme: "light".into(),
    }
}
fn default_ip() -> String {
    "192.168.4.1".into()
}
fn default_port() -> u16 {
    10001
}
fn default_cdn_url() -> String {
    DEFAULT_CDN_URL.into()
}
fn default_github_repo() -> String {
    DEFAULT_GITHUB_REPO.into()
}
fn default_theme() -> String {
    "light".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            device: default_device(),
            update: default_update(),
            app: default_app(),
        }
    }
}

// ============ 配置管理器 ============

pub struct ConfigManager {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
}

impl ConfigManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let config_path = app_data_dir.join("config.json");
        let config = Self::load_from_file(&config_path);
        let manager = ConfigManager {
            config: Mutex::new(config.clone()),
            config_path,
        };
        // 保存一次确保文件存在且包含所有默认字段
        manager.save_to_file(&config);
        manager
    }

    fn load_from_file(path: &PathBuf) -> AppConfig {
        let mut config = if path.exists() {
            match fs::read_to_string(path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => AppConfig::default(),
            }
        } else {
            AppConfig::default()
        };
        Self::migrate_update_config(&mut config);
        config
    }

    /// 迁移旧版本自动写入的占位更新地址。
    ///
    /// config.json 在首次启动时由旧默认值生成，升级后仅修改默认值不会生效；
    /// 这里识别已知占位值并替换为正式更新源，用户自定义的其他地址保持不变。
    fn migrate_update_config(config: &mut AppConfig) {
        let cdn = config.update.cdn_url.trim().trim_end_matches('/');
        if cdn.is_empty()
            || cdn == LEGACY_CDN_PREFIX
            || cdn.starts_with(&format!("{LEGACY_CDN_PREFIX}/"))
        {
            config.update.cdn_url = DEFAULT_CDN_URL.into();
        }

        let repo = config.update.github_repo.trim();
        if repo.is_empty() || repo.eq_ignore_ascii_case(LEGACY_GITHUB_REPO) {
            config.update.github_repo = DEFAULT_GITHUB_REPO.into();
        }
    }

    fn save_to_file(&self, config: &AppConfig) {
        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(config) {
            let _ = fs::write(&self.config_path, json);
        }
    }

    pub fn get_config(&self) -> AppConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, mut config: AppConfig) {
        Self::migrate_update_config(&mut config);
        self.save_to_file(&config);
        *self.config.lock().unwrap() = config;
    }

    pub fn get_close_to_tray(&self) -> bool {
        self.config.lock().unwrap().app.close_to_tray
    }
}

// ============ Tauri Commands ============

#[tauri::command]
pub fn get_app_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let manager = app.state::<ConfigManager>();
    Ok(manager.get_config())
}

#[tauri::command]
pub fn set_app_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let manager = app.state::<ConfigManager>();
    manager.set_config(config);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "xdesin-config-test-{}-{}-{}",
            name,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn default_update_uses_release_endpoints() {
        let config = AppConfig::default();
        assert_eq!(config.update.cdn_url, DEFAULT_CDN_URL);
        assert_eq!(config.update.github_repo, DEFAULT_GITHUB_REPO);
    }

    #[test]
    fn migrates_legacy_update_endpoints() {
        let mut config = AppConfig::default();
        config.update.cdn_url = "https://cdn.example.com/xdesin-hmi/".into();
        config.update.github_repo = "xdesin/xdesin-hmi".into();

        ConfigManager::migrate_update_config(&mut config);

        assert_eq!(config.update.cdn_url, DEFAULT_CDN_URL);
        assert_eq!(config.update.github_repo, DEFAULT_GITHUB_REPO);
    }

    #[test]
    fn keeps_custom_update_endpoints() {
        let mut config = AppConfig::default();
        config.update.cdn_url = "https://updates.example.org/custom".into();
        config.update.github_repo = "customer/hmi".into();

        ConfigManager::migrate_update_config(&mut config);

        assert_eq!(config.update.cdn_url, "https://updates.example.org/custom");
        assert_eq!(config.update.github_repo, "customer/hmi");
    }

    #[test]
    fn persisted_legacy_config_is_migrated_and_saved() {
        let dir = temp_dir("legacy");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(
            &path,
            r#"{
  "device": { "ip": "192.168.4.1", "port": 10001 },
  "update": {
    "cdnUrl": "https://cdn.example.com/xdesin-hmi",
    "githubRepo": "xdesin/xdesin-hmi"
  },
  "app": { "closeToTray": false, "theme": "light" }
}"#,
        )
        .unwrap();

        let manager = ConfigManager::new(dir.clone());
        let config = manager.get_config();
        assert_eq!(config.update.cdn_url, DEFAULT_CDN_URL);
        assert_eq!(config.update.github_repo, DEFAULT_GITHUB_REPO);

        let saved = fs::read_to_string(path).unwrap();
        assert!(saved.contains(DEFAULT_CDN_URL));
        assert!(saved.contains(DEFAULT_GITHUB_REPO));
        assert!(!saved.contains("cdn.example.com"));

        fs::remove_dir_all(dir).unwrap();
    }
}
