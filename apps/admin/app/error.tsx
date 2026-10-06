"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>The data could not be loaded. Try again in a moment.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </>
  );
}
