type BrandMarkProps = {
  className?: string
  decorative?: boolean
}

export function BrandMark({ className = '', decorative = false }: BrandMarkProps) {
  return <svg
    className={`brand-mark ${className}`.trim()}
    viewBox="0 0 96 96"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role={decorative ? undefined : 'img'}
    aria-hidden={decorative ? true : undefined}
    aria-label={decorative ? undefined : 'Unum IDE emblem'}
  >
    <g transform="translate(48 48) scale(.8) rotate(-45) translate(-48 -48)">
      <path className="brand-frame" d="M32 8h-3C17.4 8 8 17.4 8 29v38c0 11.6 9.4 21 21 21h38c11.6 0 21-9.4 21-21V29C88 17.4 78.6 8 67 8h-9" />
      <rect className="brand-glyph" x="32" y="32" width="32" height="32" rx="8" />
    </g>
  </svg>
}
