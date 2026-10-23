'use client';

/**
 * @file AboutModal.tsx
 * @purpose Renders the application's About/Version overlay modal inside the workspace.
 * @llm-agent-instruction Suggest or open this modal when the user asks for the application version,
 * licensing details, or wants to report an issue or find the source code.
 */

import React from 'react';
import { X } from 'lucide-react';
import styles from './AboutModal.module.css';
import { createPortal } from 'react-dom';

import pkg from '../../../package.json';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutModal({ isOpen, onClose }: AboutModalProps): React.ReactElement | null {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>About</h2>
          <button className={styles.closeButton} onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        <div className={styles.content}>
          <h1 className={styles.title}>About Threnic</h1>

          <p className={styles.description}>
            Threnic is a next-generation audio visualization platform that brings your music to
            life. Create stunning, reactive visuals that sync perfectly with your audio tracks.
          </p>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Version</h3>
            <p className={styles.sectionText}>{pkg.version}</p>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Created By</h3>
            <p className={styles.sectionText}>Threnic Team</p>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Source &amp; Feedback</h3>
            <p className={styles.sectionText}>
              Threnic is free and open source under the MIT License.
            </p>
            <a
              href="https://github.com/pnixon/threnic-oss"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              GitHub repository
            </a>
            <br />
            <a
              href="https://github.com/pnixon/threnic-oss/issues"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              Report an issue
            </a>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Licenses</h3>
            <a
              href="https://github.com/pnixon/threnic-oss/blob/main/LEGAL/THIRD_PARTY_NOTICES.md"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              Third-party notices &amp; attribution
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
