'use client'

interface Props {
  label?: string
  size?: 'small' | 'medium' | 'large'
}

export default function LiquidLoader({
  label = 'Loading',
  size = 'medium',
}: Props) {
  return (
    <div
      className={`liquid-loader liquid-loader--${size}`}
      role="status"
      aria-label={label}
    >
      <div className="liquid-loader__orbit">
        {Array.from({ length: 8 }, (_, index) => (
          <span className="liquid-loader__bubble" key={index} />
        ))}
      </div>
    </div>
  )
}
