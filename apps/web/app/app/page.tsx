export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-hero px-4 py-12">
      <div className="surface w-full max-w-lg p-6 text-center sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-wide text-primary">Patient portal</p>
        <h1 className="mt-2 font-display text-2xl font-extrabold">Patient portal</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Booking, records, prescriptions, payments and consents. Sign-in arrives with the auth
          module.
        </p>
      </div>
    </main>
  );
}
