import { useId, useRef, useState } from 'react'

/**
 * "?" badge that explains a field on hover or keyboard focus.
 * The bubble is position:fixed so scrolling side panels can't clip it.
 */
export function HelpTip({ text }: { text?: string }) {
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null)
  if (!text) return null
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const width = 260
    const x = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8)
    const below = r.top < 140
    setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below })
  }
  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        role="button"
        aria-label="What does this mean?"
        aria-describedby={pos ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        onFocus={show}
        onBlur={() => setPos(null)}
        onClick={(e) => e.preventDefault()}
        className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-slate-600 align-middle text-[9px] font-bold leading-none text-slate-400 hover:border-sky-400 hover:text-sky-300 focus:border-sky-400 focus:text-sky-300 focus:outline-none"
      >
        ?
      </span>
      {pos && (
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-[260px] rounded-md border border-slate-600 bg-slate-800 px-2.5 py-2 text-[11.5px] font-normal normal-case leading-snug tracking-normal text-slate-100 shadow-xl"
          style={{ left: pos.x, top: pos.y, transform: pos.below ? undefined : 'translateY(-100%)' }}
        >
          {text}
        </span>
      )}
    </>
  )
}
