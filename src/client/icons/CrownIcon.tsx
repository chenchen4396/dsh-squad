export function CrownIcon({
  size = 16,
  className,
  title,
}: {
  size?: number
  className?: string | undefined
  title?: string | undefined
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {title !== undefined && <title>{title}</title>}
      <path
        d="M793.18 762H231.64a45.5 45.5 0 0 1-45.17-40l-37.12-307.4c-4.36-36 33.18-62.42 65.62-46.11L492 507.76a45.5 45.5 0 0 0 40.89 0l277-139.27c32.44-16.31 70 10.07 65.62 46.11L838.36 722a45.51 45.51 0 0 1-45.18 40z"
        fill="#FCBA26"
      />
      <path
        d="M470.28 244.88L312.57 518.05c-18.73 32.43 4.68 73 42.13 73h315.43c37.45 0 60.85-40.54 42.13-73L554.54 244.88c-18.72-32.43-65.54-32.43-84.26 0z"
        fill="#FFDE09"
      />
      <path
        d="M492 507.76l-134.47-67.59-47.47 82.22c-17.61 30.5 4.41 68.63 39.63 68.63h325.45c35.22 0 57.23-38.13 39.62-68.63l-47.47-82.22-134.43 67.59a45.5 45.5 0 0 1-40.86 0z"
        fill="#FB8B06"
      />
    </svg>
  )
}
