import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Invitation',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
  referrer: 'no-referrer',
};

export default function InscriptionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
