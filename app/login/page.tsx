import { login } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Wrong password.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; from?: string };
}) {
  const errorMessage = searchParams.error
    ? ERROR_MESSAGES[searchParams.error] ?? ERROR_MESSAGES.invalid
    : null;
  const from =
    searchParams.from && searchParams.from.startsWith("/")
      ? searchParams.from
      : "/";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-[#243329] bg-[#151F1A] p-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#34D399]">
          Access
        </p>
        <h1 className="mt-2 font-display text-xl font-semibold tracking-tight text-[#E6EFE8]">
          Motivation Engine
        </h1>
        <p className="mt-1 text-sm text-[#8CA495]">
          Control Center is private. Enter the access password.
        </p>

        <form action={login} className="mt-6 flex flex-col gap-3">
          <input type="hidden" name="from" value={from} />
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            aria-label="Password"
            className="w-full rounded-md border border-[#243329] bg-[#0E1512] px-3 py-2 text-sm text-[#E6EFE8] placeholder-[#8CA495] outline-none focus:border-[#34D399]"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-[#34D399] px-3 py-2 text-sm font-semibold text-[#0E1512] transition-opacity hover:opacity-90"
          >
            Enter
          </button>
        </form>

        {errorMessage && (
          <p className="mt-4 font-mono text-xs text-[#E4B54E]" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    </main>
  );
}
