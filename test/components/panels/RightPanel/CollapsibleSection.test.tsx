import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CollapsibleSection,
  SubCollapsibleSection,
} from '@/components/panels/Inspector/CollapsibleSection';
import React from 'react';

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  ChevronDown: () => <div data-testid="chevron" />,
}));

describe('CollapsibleSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('renders with title and icon', () => {
    const Icon = () => <div data-testid="test-icon" />;
    render(
      <CollapsibleSection title="Test Section" icon={<Icon />}>
        <div>Content</div>
      </CollapsibleSection>,
    );

    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('is closed by default and opens on click', async () => {
    render(
      <CollapsibleSection title="Test Section" icon={<div />}>
        <div data-testid="content">Content</div>
      </CollapsibleSection>,
    );

    const button = screen.getByRole('button');
    const contentContainer = screen.getByTestId('content').parentElement?.parentElement;

    // Initially closed (height 0)
    expect(contentContainer).toHaveStyle({ height: '0px' });

    // Click to open
    fireEvent.click(button);

    // Mock scrollHeight
    Object.defineProperty(contentContainer!, 'scrollHeight', { value: 100, configurable: true });

    // In a real environment, the useEffect would trigger
    // Since we're in JSDOM, we might need to wait for state updates

    // Fast-forward timers for the 'auto' transition
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(contentContainer).toHaveStyle({ height: 'auto' });
  });

  it('starts open if defaultOpen is true', () => {
    // We need to mock scrollHeight before render or during render for the effect
    // But since it's an effect, we can mock it after render but before we advance timers
    render(
      <CollapsibleSection title="Test Section" icon={<div />} defaultOpen={true}>
        <div data-testid="content">Content</div>
      </CollapsibleSection>,
    );

    const contentContainer = screen.getByTestId('content').parentElement?.parentElement;

    // In JSDOM we need to mock these as they are 0
    if (contentContainer) {
      Object.defineProperty(contentContainer, 'scrollHeight', { value: 100, configurable: true });
    }

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(contentContainer?.style.height).toBe('auto');
  });
});

describe('SubCollapsibleSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('renders title and toggles open/closed', () => {
    render(
      <SubCollapsibleSection title="Sub Section" defaultOpen={false}>
        <div data-testid="sub-content">Sub Content</div>
      </SubCollapsibleSection>,
    );

    expect(screen.getByText('Sub Section')).toBeInTheDocument();
    const button = screen.getByRole('button');
    const contentContainer = screen.getByTestId('sub-content').parentElement?.parentElement;

    expect(contentContainer?.style.height).toBe('0px');

    if (contentContainer) {
      Object.defineProperty(contentContainer, 'scrollHeight', { value: 50, configurable: true });
    }

    fireEvent.click(button);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(contentContainer?.style.height).toBe('auto');
  });
});
