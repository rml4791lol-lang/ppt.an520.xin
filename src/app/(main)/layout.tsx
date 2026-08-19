import { AppShell } from "@/components/layout/app-shell";
import { SiteFooter } from "@/components/layout/site-footer";
import { getSiteConfig } from "@/data/site-config";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = getSiteConfig();
  return (
    <AppShell
      announcement={config.announcement}
      serviceEmail={config.serviceEmail}
      tutorialUrl={config.beginnerTutorialUrl}
      footer={
        <SiteFooter
          serviceEmail={config.serviceEmail}
          tutorialUrl={config.beginnerTutorialUrl}
        />
      }
    >
      {children}
    </AppShell>
  );
}
