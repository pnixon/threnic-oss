'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Music,
  FileText,
  Image as ImageIcon,
  Wand2,
  Download,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import styles from './HelpModal.module.css';

type HelpTopic =
  | 'general'
  | 'playlist'
  | 'scene'
  | 'title'
  | 'lyrics'
  | 'effects'
  | 'export'
  | 'timeline'
  | 'transitions';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
  topic?: HelpTopic;
}

const parseMarkdown = (text: string): React.ReactNode => {
  // Split the text on **bold** or `code` markers to parse and highlight inline MD formatting
  const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className={styles.inlineCode}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
};

export function HelpModal({
  isOpen,
  onClose,
  topic = 'general',
}: HelpModalProps): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<'workflow' | 'shortcuts' | 'topic'>('topic');

  // Track client-side mounting for portal
  useEffect(() => {
    const timeout = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timeout);
  }, []);

  // Switch to topic tab if topic changes and is not general
  React.useEffect(() => {
    if (topic !== 'general') {
      setActiveTab('topic');
    } else if (activeTab === 'topic') {
      setActiveTab('workflow');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to topic changes; re-running on activeTab would override the user's tab choice
  }, [topic]);

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

  const renderTopicContent = () => {
    switch (topic) {
      case 'playlist':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Playlist &amp; Tracks</h3>
            <p className={styles.sectionText}>
              Manage your music tracks in the left panel. Add multiple songs to create an album or
              EP project.
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Add Track:** Click the "+" button to import an audio file (MP3, WAV, etc).',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown('**Reorder:** Drag tracks to set your album order.')}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Analyze:** Tracks are automatically analyzed for audio-reactive visuals upon import.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Per-Track Config:** Each track has its own independent scene, lyrics, effects, and keyframes.',
                )}
              </li>
            </ul>
          </section>
        );
      case 'scene':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Stage Attributes</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                "Configure the visual foundation of your video in the **BACKGROUND** lane of the timeline at the bottom of the screen. Selecting a background clip opens the **Clip Inspector** in the right sidebar's **Timeline** tab.",
              )}
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Background Color:** Set a solid color base layer directly in the Clip Inspector.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Media Upload:** Select the Background lane to import images or videos. If you import multiple items, they form an automated slideshow.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Slideshow Sequencing:** Background clips are scheduled sequentially back-to-back. Drag and trim them directly on the timeline track.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Opacity & Brightness:** Adjust clip opacity and brightness in the Clip Inspector to ensure lyrics remain readable.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Fit Mode & Transform:** Select Cover, Contain, Stretch, or Original, and adjust Scale, Position (Offsets), and Rotation.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Tiling & Looping:** Enable seamless tiling patterns or toggle video looping/speed rates.',
                )}
              </li>
            </ul>
          </section>
        );
      case 'title':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Track Title</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                'Customize how the track title appears in your video. Title settings have been consolidated under the **Lyrics** tab in the right sidebar.',
              )}
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown('**Toggle:** Enable or disable the track title overlay.')}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Font Family:** Choose from a curated set of fonts for the title text.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown('**Font Size:** Adjust the title size relative to the viewport.')}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Position:** Control both horizontal (X) and vertical (Y) positioning of the title.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Color & Duration:** Set a custom text color and adjust visibility duration (0.5s–10s).',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Apply to All:** Propagate your title settings across all tracks in the playlist with one click.',
                )}
              </li>
            </ul>
          </section>
        );
      case 'lyrics':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Lyric Styling</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                'Control the typography, colors, and animation of your lyrics under the **Lyrics** tab in the right sidebar.',
              )}
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Appearance:** Select a font family, adjust font size, word spacing, letter spacing, and vertical position.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Colors & Glow:** Set distinct colors for Upcoming, Active, and Played words, customize outline strokes, and configure glow halos.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Active Lane:** Target styling to the base track or create lane-specific styling overrides if your song has multi-lane lyrics.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Animation & Stagger:** Choose entrance transitions (Fade In, Pop In, Slide Up, Fly In, Typewriter) and animate by Letter, Word, or Line.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Timing & Easing:** Control fade-in/fade-out durations and highlight timing parameters.',
                )}
              </li>
            </ul>
            <div className="mt-4 p-4 bg-white/5 rounded-lg border border-white/10">
              <h4 className="font-bold mb-2 flex items-center gap-2">
                <FileText size={16} /> Importing &amp; Syncing Lyrics
              </h4>
              <p className="text-sm opacity-80">
                {parseMarkdown(
                  'Import an `.lrc` file for pre-timed lyrics, or click **Sync Lyrics** in the sidebar to tap-along and time words to your audio in real-time.',
                )}
              </p>
            </div>
          </section>
        );
      case 'effects':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Visual Effects</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                'Add and customize visual effects under the **Effects** tab in the right sidebar. Effects include both 3D Scene Effects and 2D Post-Processing Shader passes.',
              )}
            </p>

            <div className="mb-4 p-3 bg-white/5 rounded-lg border border-white/10">
              <h4 className="font-bold text-sm mb-2">Scene Effects</h4>
              <ul className={styles.tipsList}>
                <li className={styles.tip}>
                  {parseMarkdown('**Oscilloscope:** Real-time interactive audio waveform.')}
                </li>
                <li className={styles.tip}>
                  {parseMarkdown(
                    '**Particles & Starfield:** Depth-filled floating particle clusters or speed-driven stars.',
                  )}
                </li>
                <li className={styles.tip}>
                  {parseMarkdown(
                    '**Rain (3D):** Atmospheric rain with falling speed and size adjustments.',
                  )}
                </li>
              </ul>
            </div>

            <div className="mb-4 p-3 bg-white/5 rounded-lg border border-white/10">
              <h4 className="font-bold text-sm mb-2">Post-Processing Effects</h4>
              <ul className={styles.tipsList}>
                <li className={styles.tip}>
                  {parseMarkdown(
                    '**Visual & Lighting:** Bloom, Chromatic Aberration, VHS Tracking, Film Grain, Noise, Sepia, Bulb Flicker, Lens Flare.',
                  )}
                </li>
                <li className={styles.tip}>
                  {parseMarkdown(
                    '**Color & Motion:** Hue Shift, Saturation, LUT Color Grading, Camera Shake, Gate Jitter, Zoom, Slide, and Distortion.',
                  )}
                </li>
              </ul>
            </div>

            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Layered Effects:** Add multiple stackable effect instances. Drag and drop rows to reorder the processing pipeline.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Audio Reactivity:** Toggle reactivity on parameters to map kick, vocals, or hi-hat frequencies (Bass, Mid, High) to visual sweeps.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Keyframed Automation:** Restrict effects to specific time ranges or automate their parameters over the timeline.',
                )}
              </li>
            </ul>
          </section>
        );
      case 'export':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Export</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                'Render your final video file locally in your browser via the **Export** tab in the right sidebar.',
              )}
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Export Range:** Export the entire song, a selected time range, or merge all tracks into one seamless video.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Quality & Aspect:** Renders up to 4K (Ultra) at custom aspect ratios (Landscape 16:9, Portrait 9:16, Square 1:1) and framerates (60, 30, 24 FPS).',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Codecs:** Supports hardware-accelerated H.264, H.265/HEVC, or AV1 streams.',
                )}
              </li>
            </ul>
          </section>
        );
      case 'timeline':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Timeline &amp; Keyframes</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                "The bottom panel hosts a scroll-synchronized multi-lane timeline for non-linear editing. Selecting timeline elements loads the inspectors in the right sidebar's **Timeline** tab.",
              )}
            </p>
            <div className="mb-4 p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg">
              <h4 className="font-bold text-purple-200 mb-2">Dedicated Timeline Tracks</h4>
              <ul className="text-xs text-purple-100/80 space-y-1.5 list-disc list-inside">
                <li>
                  {parseMarkdown(
                    '**LYRICS Track:** Displays phrase-level and word-level text sync clips. Grab to move, double-click to edit text, or press delete.',
                  )}
                </li>
                <li>
                  {parseMarkdown(
                    '**BACKGROUND Track:** Displays image, video, and solid clips. Select a clip to load the **Clip Inspector** in the sidebar (timing, loops, speed, position, opacity, brightness, blur, fit, transitions).',
                  )}
                </li>
                <li>
                  {parseMarkdown(
                    '**EFFECTS Track:** Displays parameter keyframe diamonds. Select a keyframe diamond to load the **Keyframe Inspector** in the sidebar (timestamps, interpolation ease, ramp durations, and specific property overrides).',
                  )}
                </li>
                <li>
                  <strong>AUDIO Track:</strong> Displays the high-fidelity waveform.
                </li>
              </ul>
            </div>
            <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <h4 className="font-bold text-blue-200 mb-2">Keyframe Controller</h4>
              <p className="text-sm text-blue-100/80 mb-2">
                {parseMarkdown(
                  'Click **"Add Keyframe"** at the top of the sidebar panel at any playback time. Switch active editing states using the dropdown to automate parameters smoothly.',
                )}
              </p>
            </div>
          </section>
        );
      case 'transitions':
        return (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Motion Settings &amp; Transitions</h3>
            <p className={styles.sectionText}>
              {parseMarkdown(
                "Configure how background media transitions. Found in the right sidebar's **Timeline** tab (Clip Inspector) when a background clip is selected.",
              )}
            </p>
            <ul className={styles.tipsList}>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Transition Type:** Choose crossfade, cut, slide, zoom, wipe-left, and more to blend media seamlessly.',
                )}
              </li>
              <li className={styles.tip}>
                {parseMarkdown('**Duration:** Set how long transitions take (0.1s–5.0s).')}
              </li>
              <li className={styles.tip}>
                {parseMarkdown(
                  '**Keyframe-Driven:** Keyframes automatically synchronize with slideshow boundaries to ensure frame-perfect transitions.',
                )}
              </li>
            </ul>
          </section>
        );
      default:
        return (
          <section className={styles.intro}>
            <h1 className={styles.title}>Welcome to Threnic</h1>
            <p className={styles.description}>Select a section to see specific help guidance.</p>
          </section>
        );
    }
  };

  const modalContent = (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Help &amp; Guide</h2>
          <button className={styles.closeButton} onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        <div className={styles.tabs}>
          {topic !== 'general' && (
            <button
              className={`${styles.tab} ${activeTab === 'topic' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('topic')}
            >
              {topic.charAt(0).toUpperCase() + topic.slice(1)} Guide
            </button>
          )}
          <button
            className={`${styles.tab} ${activeTab === 'workflow' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('workflow')}
          >
            Workflow
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'shortcuts' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('shortcuts')}
          >
            Shortcuts
          </button>
        </div>

        <div className={styles.content}>
          {activeTab === 'topic' && renderTopicContent()}

          {activeTab === 'workflow' && (
            <>
              <div className={styles.intro}>
                <h1 className={styles.title}>Threnic Workflow</h1>
                <p className={styles.description}>
                  Transform your music into stunning visual experiences with our streamlined
                  production workflow.
                </p>
              </div>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Production Flow</h3>
                <p className={styles.sectionText}>
                  Threnic uses a stages-based workflow to take you from raw audio to a finished
                  video.
                </p>

                <div className={styles.flowDiagram}>
                  <span className={styles.flowStep}>Your DAW</span>
                  <span className={styles.flowArrow}>→</span>
                  <span className={styles.flowStep}>Mastering</span>
                  <span className={styles.flowArrow}>→</span>
                  <span className={styles.flowStepHighlight}>Threnic</span>
                  <span className={styles.flowArrow}>→</span>
                  <span className={styles.flowStep}>Distribution</span>
                </div>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Workflow Steps</h3>
                <div className={styles.workflowSteps}>
                  <div className={styles.step}>
                    <div className={styles.stepIcon}>
                      <Music size={20} />
                    </div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>1. Add Your Track</h4>
                      <p className={styles.stepText}>
                        {parseMarkdown(
                          'Click **"+"** in the left panel. Select your audio file (MP3, WAV, etc.). Your track will be loaded and analyzed for audio-reactive effects.',
                        )}
                      </p>
                    </div>
                  </div>

                  <div className={styles.step}>
                    <div className={styles.stepIcon}>
                      <ImageIcon size={20} />
                    </div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>2. Set Up Your Stage</h4>
                      <p className={styles.stepText}>
                        {parseMarkdown(
                          "In the bottom timeline's **BACKGROUND** lane, import background images or videos. Select a clip to open the **Clip Inspector** in the right sidebar's **Timeline** tab to configure positioning, scaling, opacity, brightness, blur, and slide transition effects.",
                        )}
                      </p>
                    </div>
                  </div>

                  <div className={styles.step}>
                    <div className={styles.stepIcon}>
                      <FileText size={20} />
                    </div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>3. Add &amp; Style Lyrics</h4>
                      <p className={styles.stepText}>
                        {parseMarkdown(
                          "In the right sidebar's **Lyrics** tab, import an `.lrc` file or click **Sync Lyrics** to time lyrics in real-time. Tweak fonts, sizes, letter spacing, colors, glow, and animations.",
                        )}
                      </p>
                    </div>
                  </div>

                  <div className={styles.step}>
                    <div className={styles.stepIcon}>
                      <Wand2 size={20} />
                    </div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>4. Apply Effects</h4>
                      <p className={styles.stepText}>
                        {parseMarkdown(
                          "In the right sidebar's **Effects** tab, add scene effects (particles, rain, starfield, oscilloscope) or post-processing filters (bloom, glitch, chromatic aberration, distortion). Customize parameters and toggle audio reactivity to match beats.",
                        )}
                      </p>
                    </div>
                  </div>

                  <div className={styles.step}>
                    <div className={styles.stepIcon}>
                      <Download size={20} />
                    </div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>5. Export</h4>
                      <p className={styles.stepText}>
                        {parseMarkdown(
                          "In the right sidebar's **Export** tab, pick your resolution (up to 4K), aspect ratio, framerate, and video codec. Export your finished video file locally in your browser.",
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Pro Tips</h3>
                <ul className={styles.tipsList}>
                  <li className={styles.tip}>
                    {parseMarkdown(
                      '**Keyframes:** Add keyframes on the timeline to animate any setting over time — background, effects, lyrics, and more.',
                    )}
                  </li>
                  <li className={styles.tip}>
                    {parseMarkdown(
                      '**Presets:** Open the Preset Store (star icon) to browse and apply community presets for quick setups.',
                    )}
                  </li>
                  <li className={styles.tip}>
                    {parseMarkdown(
                      '**Apply to All:** Once you\'ve dialed in settings for one track, use "Apply to All Tracks" to propagate them across your album.',
                    )}
                  </li>
                  <li className={styles.tip}>
                    {parseMarkdown(
                      '**Save/Load Projects:** Use the settings menu to save your project as a `.thren` file, which bundles all your settings and assets.',
                    )}
                  </li>
                  <li className={styles.tip}>
                    {parseMarkdown(
                      '**Preview Often:** Use the timeline playback to preview how effects and scenes sync with your audio.',
                    )}
                  </li>
                </ul>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Feedback</h3>
                <p className={styles.sectionText}>
                  Found a bug or have an idea? Threnic is open source &mdash; open an issue on
                  GitHub.
                </p>
                <div className="mt-4">
                  <a
                    href="https://github.com/pnixon/threnic-oss/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.feedbackLink}
                  >
                    <span>Report an issue</span>
                  </a>
                </div>
              </section>
            </>
          )}

          {activeTab === 'shortcuts' && (
            <>
              <div className={styles.intro}>
                <h1 className={styles.title}>Keyboard Shortcuts</h1>
                <p className={styles.description}>
                  Speed up your workflow with these handy shortcuts.
                </p>
              </div>
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Playback</h3>
                <div className={styles.shortcutList}>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Space</span>
                    </div>
                    <span className={styles.shortcutDesc}>Play / Pause</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <SkipBack size={14} />
                      <span>Left Arrow</span>
                    </div>
                    <span className={styles.shortcutDesc}>Skip backward 5 seconds</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <SkipForward size={14} />
                      <span>Right Arrow</span>
                    </div>
                    <span className={styles.shortcutDesc}>Skip forward 5 seconds</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Ctrl + &larr;</span>
                    </div>
                    <span className={styles.shortcutDesc}>Previous track</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Ctrl + &rarr;</span>
                    </div>
                    <span className={styles.shortcutDesc}>Next track</span>
                  </div>
                </div>
              </section>
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Keyframes</h3>
                <div className={styles.shortcutList}>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>[</span>
                    </div>
                    <span className={styles.shortcutDesc}>Jump to previous keyframe</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>]</span>
                    </div>
                    <span className={styles.shortcutDesc}>Jump to next keyframe</span>
                  </div>
                </div>
              </section>
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Lyrics Timeline</h3>
                <div className={styles.shortcutList}>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Delete / Backspace</span>
                    </div>
                    <span className={styles.shortcutDesc}>Delete selected lyric word</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Ctrl + C</span>
                    </div>
                    <span className={styles.shortcutDesc}>Copy selected lyric word</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Ctrl + V</span>
                    </div>
                    <span className={styles.shortcutDesc}>Paste lyric word</span>
                  </div>
                </div>
              </section>
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>General</h3>
                <div className={styles.shortcutList}>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>?</span>
                    </div>
                    <span className={styles.shortcutDesc}>Open this help modal</span>
                  </div>
                  <div className={styles.shortcut}>
                    <div className={styles.shortcutKey}>
                      <span>Esc</span>
                    </div>
                    <span className={styles.shortcutDesc}>
                      Close modal or cancel current action
                    </span>
                  </div>
                </div>
              </section>{' '}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
