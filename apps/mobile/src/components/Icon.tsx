type IconName =
  | 'library'
  | 'note'
  | 'account'
  | 'search'
  | 'sync'
  | 'plus'
  | 'check'
  | 'back'
  | 'warning'
  | 'offline'
  | 'logout'
  | 'trash'
  | 'device'
  | 'chevron'
  | 'conflict';
const paths: Record<IconName, React.ReactNode> = {
  library: (
    <>
      <path d="M3 4v16M7 4v16M11 4v16M16 3l5 16" />
    </>
  ),
  note: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  sync: (
    <>
      <path d="M20 7a8 8 0 0 0-14-2L3 8M3 3v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  warning: (
    <>
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v5m0 3v.1" />
    </>
  ),
  offline: (
    <>
      <path d="m3 3 18 18M8 5a7 7 0 0 1 11 5 5 5 0 0 1 1 9M16 19H6a5 5 0 0 1-1-10" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-5v5" />
    </>
  ),
  conflict: (
    <>
      <path d="M6 3v5c0 6 12 2 12 8v5M18 3v5c0 2-1 3-3 4M6 21v-5m-3 2 3 3 3-3m6-12 3-3 3 3" />
    </>
  ),
};
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
