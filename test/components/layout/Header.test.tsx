import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Header } from '@/components/layout/Header';
import React from 'react';
import { HelpProvider, ThemeProvider } from '@/contexts';

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  Music: () => <div data-testid="music-icon" />,
  X: () => <div data-testid="x-icon" />,
  Settings: () => <div data-testid="settings-icon" />,
  LogOut: () => <div data-testid="logout-icon" />,
  Info: () => <div data-testid="info-icon" />,
  HelpCircle: () => <div data-testid="help-circle-icon" />,
  FileText: () => <div data-testid="file-icon" />,
  Shield: () => <div data-testid="shield-icon" />,
  AlertCircle: () => <div data-testid="alert-icon" />,
  Activity: () => <div data-testid="activity-icon" />,
  Moon: () => <div data-testid="moon-icon" />,
  Sun: () => <div data-testid="sun-icon" />,
  Eye: () => <div data-testid="eye-icon" />,
  LogIn: () => <div data-testid="login-icon" />,
  Copy: () => <div data-testid="copy-icon" />,
  Check: () => <div data-testid="check-icon" />,
  FolderOpen: () => <div data-testid="folder-open-icon" />,
  Archive: () => <div data-testid="archive-icon" />,
  Zap: () => <div data-testid="zap-icon" />,
  Sparkles: () => <div data-testid="sparkles-icon" />,
  Monitor: () => <div data-testid="monitor-icon" />,
  Smartphone: () => <div data-testid="smartphone-icon" />,
  Square: () => <div data-testid="square-icon" />,
}));

vi.mock('@/contexts/PlaylistContext', () => ({
  useProjectIOAPI: () => ({
    importProject: vi.fn(),
    exportCurrentProject: vi.fn(),
    loadProjectFromManifest: vi.fn(),
    convertProjectToManifest: vi.fn(),
  }),
}));

vi.mock('@/engine/export', () => ({
  useExportUIStore: vi.fn(),
}));

// Mock Next Image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock Headless UI
vi.mock('@headlessui/react', () => ({
  Menu: Object.assign(({ children }: any) => <div>{children}</div>, {
    Button: ({ children, className }: any) => <button className={className}>{children}</button>,
    Items: ({ children, className }: any) => <div className={className}>{children}</div>,
    Item: ({ children }: any) => <div>{children({ active: false })}</div>,
  }),
  Transition: ({ children }: any) => <div>{children}</div>,
}));

// Mock Modals
vi.mock('@/components/modals', () => ({
  AboutModal: () => <div data-testid="about-modal" />,
  HelpModal: () => <div data-testid="help-modal" />,
  AIDirectorChatbot: () => <div data-testid="ai-director-chatbot" />,
}));

import { useExportUIStore } from '@/engine/export';

describe('Header Component', () => {
  const mockCancelExport = vi.fn();

  beforeEach(() => {
    vi.mocked(useExportUIStore).mockImplementation((selector: any) => {
      // Default state for tests
      const state = {
        isExporting: false,
        progress: { percentage: 0 },
        cancelExport: mockCancelExport,
      };
      return selector(state);
    });
  });

  it('renders project name', () => {
    render(
      <ThemeProvider>
        <HelpProvider>
          <Header projectName="Test Project" />
        </HelpProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('renders default project name when not provided', () => {
    render(
      <ThemeProvider>
        <HelpProvider>
          <Header />
        </HelpProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText('Untitled Project')).toBeInTheDocument();
  });

  it('shows export progress when isExporting is true', () => {
    vi.mocked(useExportUIStore).mockImplementation((selector: any) => {
      const state = {
        isExporting: true,
        progress: { percentage: 45 },
        cancelExport: mockCancelExport,
      };
      return selector(state);
    });

    render(
      <ThemeProvider>
        <HelpProvider>
          <Header />
        </HelpProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText('Exporting 45%')).toBeInTheDocument();
  });

  it('does not show export progress when isExporting is false', () => {
    render(
      <ThemeProvider>
        <HelpProvider>
          <Header />
        </HelpProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByText(/Exporting/)).not.toBeInTheDocument();
  });

  it('calls cancelExport when close button is clicked', () => {
    vi.mocked(useExportUIStore).mockImplementation((selector: any) => {
      const state = {
        isExporting: true,
        progress: { percentage: 45 },
        cancelExport: mockCancelExport,
      };
      return selector(state);
    });

    render(
      <ThemeProvider>
        <HelpProvider>
          <Header />
        </HelpProvider>
      </ThemeProvider>,
    );

    const closeButton = screen.getByTitle('Cancel Export');
    fireEvent.click(closeButton);

    expect(mockCancelExport).toHaveBeenCalled();
  });
});
