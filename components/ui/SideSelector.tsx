'use client'

import type { SideSelection } from '@/lib/store/pedal-store'

interface SideSelectorProps {
  value: SideSelection
  disabled?: boolean
  onChange: (side: SideSelection) => void
}

const options: { value: SideSelection; label: string }[] = [
  { value: 'A', label: 'A 侧' },
  { value: 'NONE', label: '双侧' },
  { value: 'B', label: 'B 侧' },
]

/** A/B/NONE 三态分段选择器 */
export default function SideSelector({ value, disabled, onChange }: SideSelectorProps) {
  return (
    <div
      className={`inline-flex rounded-lg border border-outline-variant overflow-hidden ${disabled ? 'opacity-50' : ''}`}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`px-6 py-2 font-label-bold text-sm transition-colors ${
            value === opt.value
              ? 'bg-primary text-on-primary'
              : 'bg-white text-on-surface-variant hover:bg-surface-container'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
