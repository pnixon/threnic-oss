import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

// Optional: set SITE_URL when self-hosting so Open Graph image URLs resolve to absolute links.
const siteUrl = process.env.SITE_URL;

export const metadata: Metadata = {
  title: 'Threnic | GPU-Accelerated Lyric Video Engine',
  description:
    'Create audio-reactive lyric videos with real-time 3D rendering and 4K video export. Everything runs locally in your browser.',
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  openGraph: {
    title: 'Threnic | Free, Open Source Lyric Videos',
    description: 'High-performance audio-reactive lyric videos in your browser.',
    siteName: 'Threnic',
    images: [
      {
        url: '/icons/og-image.jpg',
        width: 1200,
        height: 630,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/Threnic_Logo.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: { url: '/icons/apple-touch-icon-180.png', sizes: '180x180' },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
