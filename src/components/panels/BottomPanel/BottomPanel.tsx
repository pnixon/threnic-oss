'use client';

import React from 'react';
import { Timeline } from '@/components/panels/Timeline/Timeline';
import styles from './BottomPanel.module.css';

import type { ThrenicWord } from '@/types/lyrics';
import type { Keyframe } from '@/types/keyframes';
import type { VideoClip } from '@/types/video-clips';

interface BottomPanelProps {
  // Timeline Props
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  audioBuffer?: AudioBuffer | null;
  onRecallView?: () => void;
  onSaveView?: () => void;
  /** Disable interactions */
  disabled?: boolean;
  onNextTrack?: () => void;
  onPreviousTrack?: () => void;
  isLastTrack?: boolean;
  /** Shared words state */
  words?: ThrenicWord[];
  setWords?: React.Dispatch<React.SetStateAction<ThrenicWord[]>>;
  /** Audio element ref for seeking etc */
  audioElementRef?: React.RefObject<HTMLAudioElement | null>;
  /** Keyframes for scene transitions and automation */
  keyframes?: Keyframe[];
  setKeyframes?: React.Dispatch<React.SetStateAction<Keyframe[]>>;
  /** Video clips for background slideshow integration */
  videoClips?: VideoClip[];
  setVideoClips?: React.Dispatch<React.SetStateAction<VideoClip[]>>;
  // Option 2 props
  selectedTrackId?: string | null;
  updateTrackKeyframes?: (id: string, keyframes: Keyframe[]) => void;
  onNextKeyframe?: () => void;
}

export function BottomPanel(props: BottomPanelProps) {
  return (
    <div className={styles.panel}>
      {/* Content Area - Always Timeline */}
      <div className={styles.content}>
        <Timeline
          duration={props.duration}
          isPlaying={props.isPlaying}
          playbackRate={props.playbackRate}
          onPlayPause={props.onPlayPause}
          onSeek={props.onSeek}
          onPlaybackRateChange={props.onPlaybackRateChange}
          audioBuffer={props.audioBuffer}
          disabled={props.disabled}
          onNextTrack={props.onNextTrack}
          onPreviousTrack={props.onPreviousTrack}
          onNextKeyframe={props.onNextKeyframe}
          isLastTrack={props.isLastTrack}
          words={props.words}
          setWords={props.setWords}
          audioElementRef={props.audioElementRef}
          keyframes={props.keyframes}
          setKeyframes={props.setKeyframes}
          videoClips={props.videoClips}
          setVideoClips={props.setVideoClips}
          selectedTrackId={props.selectedTrackId}
          updateTrackKeyframes={props.updateTrackKeyframes}
        />
      </div>
    </div>
  );
}
