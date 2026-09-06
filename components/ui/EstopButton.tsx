'use client'

import { useState } from 'react'

/**
 * 全局常驻急停按钮：ESTOP 免等待直发，不占用命令队列
 */
export default function EstopButton({ onEstop }: { onEstop: () => Promise<void> | void }) {
  const [fired, setFired] = useState(false)

  const handleClick = async () => {
    setFired(true)
    setTimeout(() => setFired(false), 1500)
    await onEstop()
  }

  return (
    <button
      onClick={handleClick}
      className={`flex items-center gap-2 px-6 h-14 rounded-xl font-label-bold text-base tracking-widest text-white transition-all select-none ${
        fired
          ? 'bg-red-800 scale-95 shadow-inner'
          : 'bg-critical hover:bg-red-700 active:scale-95 shadow-lg shadow-red-300'
      }`}
      title="急停：立即停止所有电机并复位全部流程"
    >
      <span className="material-symbols-outlined text-[28px]">emergency_home</span>
      急停
    </button>
  )
}
