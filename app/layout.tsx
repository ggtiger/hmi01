import type { Metadata, Viewport } from 'next'
import './globals.css'
import TopAppBar from '@/components/ui/TopAppBar'
import InfoBar from '@/components/ui/InfoBar'
import AppReady from '@/components/AppReady'

export const metadata: Metadata = {
  title: 'XdesinHMI | 踏板总成测试台',
  description: 'Xdesin 踏板总成测试台上位机 - 精密工业监测与遥测接口',
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
        <div className="relative flex flex-col h-screen z-[1]">
          <TopAppBar />
          <main className="flex-1 min-h-0 overflow-hidden">
            {children}
          </main>
          <InfoBar />
        </div>
      </body>
    </html>
  )
}
