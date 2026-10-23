import { render, screen } from '@testing-library/react';
import RootLayout from '@/app/layout';
import { expect, vi, it, describe } from 'vitest';

// Mock next/font/google
vi.mock('next/font/google', () => ({
  Inter: () => ({
    variable: '--font-inter',
  }),
}));

// Mock metadata
vi.mock('next', () => ({
  Metadata: {},
}));

vi.mock('@/components/auth/ProtectedLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@next/third-parties/google', () => ({
  GoogleTagManager: () => null,
}));

describe('RootLayout', () => {
  // To avoid hydration warnings (html cannot be child of div),
  // we check the layout logic without rendering the full tag structure
  // into the default RTL container.

  it('renders children correctly', () => {
    // We render into document.body directly to avoid the div wrapper
    const { getByTestId, getByText } = render(
      <RootLayout>
        <div data-testid="test-child">Test Child</div>
      </RootLayout>,
      { container: document.documentElement },
    );

    expect(getByTestId('test-child')).toBeInTheDocument();
    expect(getByText('Test Child')).toBeInTheDocument();
  });

  it('has correct html and body classes', () => {
    const { getByTestId } = render(
      <RootLayout>
        <div data-testid="content">Content</div>
      </RootLayout>,
      { container: document.documentElement },
    );

    // In JSDOM, when we render components that include <html> and <body>,
    // react-testing-library might not handle it as a full document replace.
    // However, let's check the document elements directly.
    const html = document.documentElement;
    const body = document.body;

    expect(html).toHaveAttribute('lang', 'en');
    expect(body).toHaveClass('--font-inter');
    expect(body).toHaveClass('antialiased');
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });
});
