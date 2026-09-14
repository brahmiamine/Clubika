import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./components/providers/theme-provider";
import { Toaster } from "./components/ui/sonner";
import { AppThemeSync } from "./components/providers/app-theme-sync";
import { AuthProvider } from "./components/providers/auth-provider";
import { AppShell, AppShellMain } from "./components/layout/AppShell";
import { MobileTabBar } from "./components/layout/MobileTabBar";
import { PwaProvider } from "./components/providers/pwa-provider";
import { IncomingNotificationOverlay } from "./components/notifications/IncomingNotificationOverlay";
import { buildPwaMetadata, resolveAppProductBranding } from "@/lib/pwa/branding";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = buildPwaMetadata(resolveAppProductBranding());

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <AppShell>
            <AppThemeSync />
            <AuthProvider>
              <PwaProvider>
                <AppShellMain>{children}</AppShellMain>
                <MobileTabBar />
                <IncomingNotificationOverlay />
              </PwaProvider>
            </AuthProvider>
            <Toaster />
          </AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
