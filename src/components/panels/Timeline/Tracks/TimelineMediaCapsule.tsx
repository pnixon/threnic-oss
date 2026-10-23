'use client';

import React from 'react';
import { Film, Image as ImageIcon, Palette } from 'lucide-react';
import { isVideoUrl } from '@/engine/gpu/TextureLoader';

interface TimelineMediaCapsuleProps {
  url?: string;
  backgroundColor?: string;
  name?: string;
  thumbnailOnly?: boolean;
  behavior?: string;
  style?: React.CSSProperties;
}

export function TimelineMediaCapsule({
  url,
  backgroundColor,
  name,
  thumbnailOnly = false,
  behavior,
  style,
}: TimelineMediaCapsuleProps) {
  const isVideo = url && isVideoUrl(url, name);
  const isImage = url && !isVideo;

  // Track load failures per-source so a broken thumbnail URL degrades to an
  // icon fallback instead of the browser's broken-image glyph.
  const [imageFailed, setImageFailed] = React.useState(false);
  const [videoFailed, setVideoFailed] = React.useState(false);
  React.useEffect(() => {
    setImageFailed(false);
    setVideoFailed(false);
  }, [url]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: thumbnailOnly ? '4px' : '8px',
    background: 'rgba(10, 10, 12, 0.4)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: thumbnailOnly ? '4px' : '6px',
    padding: thumbnailOnly ? '2px 4px' : '4px 8px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
    height: '100%',
    width: 'max-content',
    maxWidth: '100%',
    overflow: 'hidden',
    userSelect: 'none',
    boxSizing: 'border-box',
    ...style,
  };

  const previewStyle: React.CSSProperties = {
    width: thumbnailOnly ? '16px' : '28px',
    height: thumbnailOnly ? '16px' : '28px',
    borderRadius: thumbnailOnly ? '2px' : '4px',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    position: 'relative',
    flexShrink: 0,
  };

  const renderPreview = () => {
    if (backgroundColor && !url) {
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: backgroundColor,
            boxShadow: `inset 0 0 6px rgba(0, 0, 0, 0.3), 0 0 8px ${backgroundColor}`,
            borderRadius: 'inherit',
          }}
        />
      );
    }

    if (isVideo && !videoFailed) {
      return (
        <>
          <video
            src={url}
            muted
            playsInline
            autoPlay
            loop
            onError={() => setVideoFailed(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
          {!thumbnailOnly && (
            <div
              style={{
                position: 'absolute',
                bottom: 1,
                right: 1,
                background: 'rgba(0,0,0,0.6)',
                borderRadius: 2,
                padding: '1px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Film size={6} style={{ color: '#06b6d4' }} />
            </div>
          )}
        </>
      );
    }

    if (isImage && !imageFailed) {
      return (
        <img
          src={url}
          alt={name || 'Preview'}
          onError={() => setImageFailed(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      );
    }

    // Fallbacks (including a failed image/video load): show an icon that
    // matches the intended media type rather than a broken-image glyph.
    if (isVideo) {
      return <Film size={thumbnailOnly ? 10 : 14} style={{ color: '#94a3b8' }} />;
    }
    if (url) {
      return <ImageIcon size={thumbnailOnly ? 10 : 14} style={{ color: '#94a3b8' }} />;
    }

    return <Palette size={thumbnailOnly ? 10 : 14} style={{ color: '#94a3b8' }} />;
  };

  return (
    <div style={containerStyle} className="media-capsule" title={name || 'Media Asset'}>
      <div style={previewStyle}>{renderPreview()}</div>

      {!thumbnailOnly && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              fontSize: '9px',
              fontWeight: 700,
              color: '#ffffff',
              lineHeight: 1.1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name || (backgroundColor ? 'Solid Color' : 'Media Asset')}
          </span>
          {behavior && (
            <span
              style={{
                fontSize: '7px',
                color: 'rgba(255, 255, 255, 0.4)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                lineHeight: 1,
                marginTop: '1px',
              }}
            >
              {behavior}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
