export default function Loading() {
  return (
    <main
      className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-0"
      role="status"
      aria-live="polite"
      aria-label="页面加载中"
    >
      <div className="animate-pulse space-y-6">
        <div className="h-4 w-28 rounded-full bg-line" />
        <div className="h-10 w-2/3 rounded-2xl bg-line" />
        <div className="h-4 w-1/2 rounded-full bg-line" />
        <div className="h-64 rounded-2xl border border-line bg-card" />
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="h-32 rounded-2xl border border-line bg-card" />
          <div className="h-32 rounded-2xl border border-line bg-card" />
          <div className="h-32 rounded-2xl border border-line bg-card" />
        </div>
      </div>
      <span className="sr-only">页面加载中…</span>
    </main>
  );
}
