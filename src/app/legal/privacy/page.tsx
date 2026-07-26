export const metadata = { title: "Privacy · AR Studio" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-[70ch] px-6 py-24">
      <h1 className="text-section">Privacy</h1>
      <div className="mt-10 space-y-6 text-body text-muted">
        <p className="text-fg">
          Your camera footage never leaves your device. It is not uploaded, not written to disk, and
          never passes through our servers. Person detection and effect rendering both run inside
          your browser.
        </p>
        <p>
          What we do collect: account details returned by Google sign-in (email, name, avatar), your
          order history, and anonymous usage events — which template you opened, whether you granted
          camera access, whether you finished a recording. Clips you record belong to you. We do not
          store them and claim no license over them.
        </p>
        <p>
          Analytics cookies are off by default and only run after you explicitly consent. You can
          export your data or delete your account at any time; deletion clears all backups within 30
          days.
        </p>
        <p className="text-note">
          TODO: needs legal review before launch — retention periods, the list of sub-processors
          (Stripe, PostHog), and how data-subject rights are exercised under GDPR.
        </p>
      </div>
    </main>
  );
}
