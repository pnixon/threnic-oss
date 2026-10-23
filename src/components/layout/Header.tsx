'use client';

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import {
  Music,
  X,
  Settings,
  Info,
  HelpCircle,
  AlertCircle,
  Moon,
  Sun,
  Eye,
  FolderOpen,
  Archive,
  Zap,
  Monitor,
  Smartphone,
  Square as SquareIcon,
} from 'lucide-react';
import styles from './Header.module.css';
import { useMediaQuery } from '@/hooks';
import { ASPECT_RATIOS, AspectKey } from '@/types/exportConstants';
import { AboutModal, HelpModal } from '@/components/modals';
import { useHelp, useTheme } from '@/contexts';
import { useProjectIOAPI } from '@/contexts/PlaylistContext';
import { checkWebGPUSupport } from '@/engine/gpu/webgpu-support';
import {
  DropdownPanel,
  DropdownItem,
  DropdownDivider,
  DropdownHeader,
} from '@/components/shared/DropdownMenu';
import { toast } from '@/utils/toast';
import { ProfilerMenuItems } from './ProfilerMenuItems';
import { collectProjectState } from '@/utils/project';
import type { EffectsConfig } from '@/types/effects';
import { useExportUIStore } from '@/engine/export';
import {
  exportProjectToZip,
  saveProjectZip,
  openProjectZip,
  importProjectFromZip,
} from '@/utils/projectZip';

interface HeaderProps {
  projectName?: string;
}

const ISSUES_URL = 'https://github.com/pnixon/threnic-oss/issues';

const ASPECT_ICONS: Record<string, typeof Monitor> = {
  Landscape: Monitor,
  Portrait: Smartphone,
  Square: SquareIcon,
};

export function Header({ projectName = 'Untitled Project' }: HeaderProps): React.ReactElement {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isExporting = useExportUIStore((s) => s.isExporting);
  const exportProgress = useExportUIStore((s) => s.progress?.percentage ?? 0);
  const cancelExport = useExportUIStore((s) => s.cancelExport);
  const exportAspect = useExportUIStore((s) => s.exportAspect);
  const setExportAspect = useExportUIStore((s) => s.setExportAspect);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuWrapperRef = useRef<HTMLDivElement>(null);
  const { isOpen: isHelpModalOpen, openHelp, closeHelp, topic } = useHelp();
  const { theme, setTheme } = useTheme();
  const { exportCurrentProject, loadProjectFromManifest, convertProjectToManifest } =
    useProjectIOAPI();
  const [webGPUSupported, setWebGPUSupported] = useState<boolean | null>(null);

  useEffect(() => {
    checkWebGPUSupport().then(setWebGPUSupported);
  }, []);

  // Keyboard shortcut: ? to open help
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        openHelp();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [openHelp]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuWrapperRef.current && !menuWrapperRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  return (
    <div className={styles.header} data-testid="app-header">
      <div className={styles.logo}>
        <Image
          src="/Threnic_Logo.png"
          alt="Threnic Logo"
          className={styles.logoImage}
          width={24}
          height={24}
          data-testid="logo-image"
        />
        <div className={styles.logoTextContainer}>
          <span className={styles.logoText}>Threnic</span>
        </div>
      </div>

      {isMobile && (
        <div className={styles.mobileAspectSelector}>
          {Object.entries(ASPECT_RATIOS).map(([key, config]) => {
            const Icon = ASPECT_ICONS[key] || SquareIcon;
            const isSelected = exportAspect === key;

            return (
              <button
                key={key}
                onClick={() => setExportAspect(key as AspectKey)}
                title={config.label}
                disabled={isExporting}
                className={`${styles.mobileAspectBtn} ${isSelected ? styles.active : ''}`}
              >
                <Icon size={16} />
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.projectName}>
        <Music size={14} />
        <span>{projectName}</span>
      </div>

      {webGPUSupported !== null && (
        <div
          className={`${styles.gpuBadge} ${webGPUSupported ? styles.webgpu : styles.webgl}`}
          title={webGPUSupported ? 'WebGPU Active' : 'WebGL Fallback Active'}
        >
          <Zap size={10} fill={webGPUSupported ? 'currentColor' : 'none'} />
          <span className={styles.gpuBadgeText}>{webGPUSupported ? 'WebGPU' : 'WebGL'}</span>
        </div>
      )}

      <div className={styles.spacer} />

      {isExporting && (
        <div className={styles.exportProgress}>
          <div className={styles.progressBar} data-testid="export-progress-bar">
            <div className={styles.progressFill} style={{ width: `${exportProgress}%` }} />
          </div>
          <span className={styles.progressText}>Exporting {Math.round(exportProgress)}%</span>
          <button
            className={`btn-ghost ${styles.actionBtn}`}
            onClick={cancelExport}
            title="Cancel Export"
            style={{ marginLeft: 8, padding: 4 }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className={`relative ml-2 ${styles.menuWrapper}`} ref={menuWrapperRef}>
        <button
          className={`btn-ghost ${styles.settingsBtn} rounded-lg hover:bg-white/10 transition-colors`}
          onClick={() => setIsMenuOpen((v) => !v)}
          aria-label="Settings"
          aria-expanded={isMenuOpen}
        >
          <Settings size={18} className="text-gray-400" />
        </button>

        {isMenuOpen && (
          <DropdownPanel className={styles.settingsDropdown} onClick={() => setIsMenuOpen(false)}>
            {isMobile && (
              <div className={styles.mobileSettingsHeader} onClick={(e) => e.stopPropagation()}>
                <span className={styles.mobileSettingsTitle}>Settings</span>
                <button
                  type="button"
                  className={styles.mobileSettingsCloseBtn}
                  onClick={() => setIsMenuOpen(false)}
                  aria-label="Close Settings"
                >
                  <X size={18} />
                </button>
              </div>
            )}
            <DropdownHeader>Theme</DropdownHeader>
            <DropdownItem
              icon={<Moon size={14} />}
              selected={theme === 'dark'}
              onClick={() => setTheme('dark')}
            >
              Dark
            </DropdownItem>
            <DropdownItem
              icon={<Sun size={14} />}
              selected={theme === 'light'}
              onClick={() => setTheme('light')}
            >
              Light
            </DropdownItem>
            <DropdownItem
              icon={<Eye size={14} />}
              selected={theme === 'high-contrast'}
              onClick={() => setTheme('high-contrast')}
            >
              High Contrast
            </DropdownItem>
            <DropdownDivider />

            <DropdownItem
              icon={<FolderOpen size={14} />}
              onClick={async () => {
                try {
                  const file = await openProjectZip();
                  if (!file) return;

                  // Detect whether this is a ZIP archive or legacy JSON
                  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
                  const isZip = header[0] === 0x50 && header[1] === 0x4b; // PK magic bytes

                  if (isZip) {
                    const { project, assets, warnings } = await importProjectFromZip(file);
                    if (warnings.length > 0) {
                      console.warn('ZIP import warnings:', warnings);
                    }
                    const { projectContainsCustomShaders } = await import('@/utils/projectImport');
                    if (
                      projectContainsCustomShaders(project) &&
                      !window.confirm(
                        'This project contains custom shader code (WGSL or GLSL) that will run on your GPU. ' +
                          'Only load projects from sources you trust. Continue?',
                      )
                    ) {
                      setIsMenuOpen(false);
                      return;
                    }
                    const manifest = convertProjectToManifest(project);
                    await loadProjectFromManifest(manifest, assets);
                  } else {
                    // Legacy JSON .thren file — parse as plain text
                    const jsonText = await file.text();
                    const { deserializeProject } = await import('@/utils/project');
                    const { project } = deserializeProject(jsonText);
                    const { projectContainsCustomShaders } = await import('@/utils/projectImport');
                    if (
                      projectContainsCustomShaders(project) &&
                      !window.confirm(
                        'This project contains custom shader code (WGSL or GLSL) that will run on your GPU. ' +
                          'Only load projects from sources you trust. Continue?',
                      )
                    ) {
                      setIsMenuOpen(false);
                      return;
                    }
                    const manifest = convertProjectToManifest(project);
                    await loadProjectFromManifest(manifest);
                  }
                  toast.success('Project loaded successfully');
                } catch (error) {
                  console.error('Failed to load project:', error);
                  toast.error('Failed to load project');
                }
                setIsMenuOpen(false);
              }}
            >
              Load Project (.thren)
            </DropdownItem>
            <DropdownItem
              icon={<Archive size={14} />}
              onClick={async () => {
                try {
                  const { tracks: projectTracks, settings: projectSettings } =
                    exportCurrentProject();

                  const selectedTrack = projectTracks[0];
                  const project = collectProjectState({
                    trackName: selectedTrack?.name || projectName || 'Untitled Project',
                    artist: selectedTrack?.artist,
                    audioFilePath: selectedTrack?.audioFilePath || null,
                    currentTrackId: selectedTrack?.id,
                    backgroundImagePath: selectedTrack?.backgroundImageFilePath || null,
                    lyrics: selectedTrack?.lyricsData || [],
                    lyricsFilePath: selectedTrack?.lyricsFilePath,
                    fontSize: selectedTrack?.lyricsTheme?.fontSize ?? 0.8,
                    fontId: selectedTrack?.lyricsTheme?.fontId || 'roboto',
                    lyricColors: selectedTrack?.lyricsTheme?.colors || {
                      pre: '#666666',
                      active: '#d946ef',
                      post: '#444444',
                    },
                    verticalPosition: selectedTrack?.lyricsTheme?.verticalPosition ?? 10,
                    effectScope: 'word',
                    wordSpacing: selectedTrack?.lyricsTheme?.wordSpacing ?? 1.0,
                    glowEnabled: selectedTrack?.lyricsTheme?.glowEnabled,
                    glowColor: selectedTrack?.lyricsTheme?.glowColor,
                    glowIntensity: selectedTrack?.lyricsTheme?.glowIntensity,
                    outlineColor: selectedTrack?.lyricsTheme?.outlineColor,
                    fadeInDuration: 1.0,
                    fadeOutDuration: 1.0,
                    animationType: 'none',
                    animationStagger: 'word',
                    activeScaleEnabled: false,
                    tracks: projectTracks,
                    effectsConfig: selectedTrack?.effectsConfig || ({} as EffectsConfig),
                    playlistSettings: projectSettings,
                  });

                  toast.info('Packaging project...');
                  const zipBlob = await exportProjectToZip({
                    project,
                    tracks: projectTracks,
                  });

                  const sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(1);
                  await saveProjectZip(zipBlob, selectedTrack?.name || projectName || 'Untitled');
                  toast.success(`Project saved (${sizeMB} MB)`);
                } catch (error) {
                  console.error('Failed to save project:', error);
                  toast.error('Failed to save project');
                }
                setIsMenuOpen(false);
              }}
            >
              Save Project (.thren)
            </DropdownItem>
            <ProfilerMenuItems onAction={() => setIsMenuOpen(false)} />
            <DropdownDivider />

            <DropdownItem
              icon={<HelpCircle size={14} />}
              onClick={() => {
                openHelp();
                setIsMenuOpen(false);
              }}
            >
              Help &amp; Guide
            </DropdownItem>
            <DropdownItem
              icon={<Info size={14} />}
              onClick={() => {
                setIsAboutModalOpen(true);
                setIsMenuOpen(false);
              }}
            >
              About
            </DropdownItem>
            <DropdownDivider />
            <DropdownItem
              icon={<AlertCircle size={14} />}
              href={ISSUES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Report an Issue
            </DropdownItem>
          </DropdownPanel>
        )}
      </div>

      <AboutModal isOpen={isAboutModalOpen} onClose={() => setIsAboutModalOpen(false)} />
      <HelpModal isOpen={isHelpModalOpen} onClose={closeHelp} topic={topic} />
    </div>
  );
}
