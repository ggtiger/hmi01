import type { Metadata, Viewport } from 'next'
import './globals.css'
import V6Shell from '@/components/ui/V6Shell'
import AppReady from '@/components/AppReady'

export const metadata: Metadata = {
  title: '智能驾驶舱检测系统',
  description: '智能驾驶舱检测系统 - 踏板/转盘综合检测与遥测监控',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN" className="h-full overflow-hidden">
      <body className="font-inter text-on-background h-full overflow-hidden app-bg">
        <AppReady />
        <div className="relative h-screen z-[1]">
          <V6Shell>{children}</V6Shell>
        </div>
      </body>
    </html>
  )
}
