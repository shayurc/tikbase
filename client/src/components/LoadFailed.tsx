import { AlertCircle } from 'lucide-react';

// A failed request and an empty result are different facts, and the pages used
// to show the same thing for both: a fetch that threw fell through to "No
// products in this view yet" or "No videos for this niche". During an outage
// that told people nothing was selling on TikTok Shop. CLAUDE.md, "Numbers
// must not lie": an absent figure is not a zero, and a failed load is not an
// empty catalogue.
export function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center text-center py-20 px-6" role="alert" data-testid="load-failed">
      <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
        <AlertCircle size={20} className="text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">Couldn't load {what}</p>
      <p className="text-xs text-muted-foreground max-w-xs mb-4">
        This is a problem reaching our servers, not an empty result. Nothing here says what is or isn't selling.
      </p>
      <button
        onClick={onRetry}
        className="h-9 px-4 rounded-md text-xs font-bold bg-primary text-primary-foreground"
        data-testid="btn-retry-load"
      >
        Try again
      </button>
    </div>
  );
}
