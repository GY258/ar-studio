export const metadata = { title: "Terms · AR Studio" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-[70ch] px-6 py-24">
      <h1 className="text-section">Terms</h1>
      <div className="mt-10 space-y-6 text-body text-muted">
        <p>This service is intended for people aged 16 and over. We do not knowingly collect information from minors.</p>
        <p>
          Paid templates are a one-time purchase, not a subscription, and stay unlocked permanently.
          If a template cannot be used for technical reasons you may request a refund; the matching
          entitlement is revoked automatically when a refund is issued.
        </p>
        <p>Anything you record with this service is yours, free to use for any purpose, including commercially.</p>
        <p className="text-note">TODO: needs legal review before launch.</p>
      </div>
    </main>
  );
}
