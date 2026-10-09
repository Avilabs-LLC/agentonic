// Web access as a coloured globe, beside Gmail's and Drive's marks: our own
// drawing, not a brand logo, and not a status signal (§9).
export function WebIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="21" fill="#1e88e5" />
      <path
        fill="#43a047"
        d="M13.5 9.6c3.3-.6 6.1.9 6.4 3.4.3 2.2-1.8 3.3-1.4 5.6.4 2.2 3.3 2.6 3.2 5.2-.1 2.9-3.5 3.6-4.2 6.6-.6 2.5.9 5.4-.6 7.6-3.9-2.2-7-5.9-8.4-10.4-.5-1.6.7-2.8.5-4.5-.3-2.1-2.3-2.9-2.1-5 .2-1.7 1.3-3.1 2.6-4.2 1.2-1.1 2.5-2.1 4-2.9zM31.6 5.9c4.4 1.6 8 4.7 10.2 8.7-1.5 1.1-3.6.6-5.1 1.7-1.7 1.3-1.1 4-2.8 5.3-1.6 1.2-4 .2-5.4-1.3-1.5-1.6-1.4-4.2-.2-6 1.1-1.6 3-2.6 3.5-4.5.3-1.3-.2-2.6-.2-3.9zM34.9 28.4c2.2-.6 4.6.6 5.3 2.7-1.7 3.6-4.5 6.6-8 8.6-1.1-1.9-.6-4.4.4-6.4.6-1.9.4-4.3 2.3-4.9z"
      />
      <g fill="none" stroke="#fff" strokeOpacity=".85" strokeWidth="1.5">
        <ellipse cx="24" cy="24" rx="9" ry="21" />
        <path d="M3 24h42M5.6 14h36.8M5.6 34h36.8" />
      </g>
    </svg>
  )
}
