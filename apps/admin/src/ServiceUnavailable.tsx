/** Rendered inside the normal layout when the api is down, so the HTML is complete without JS. */
// Returns 200, not 503: a server component cannot cleanly set the status once the layout renders.
export function ServiceUnavailable({ retryHref }: { retryHref: string }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>The data could not be loaded. Try again in a moment.</p>
      <p>
        <a href={retryHref}>Try again</a>
      </p>
    </>
  );
}
