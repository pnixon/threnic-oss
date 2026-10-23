/**
 * useProjectRestore — One-time IDB project restore on app startup.
 *
 * This hook handles ONLY the restore side of persistence.
 * Auto-saving is now handled by the autoPersist middleware
 * which subscribes directly to projectStore.
 */
import { useState, useEffect } from 'react';

import type { Track } from '@/contexts/types';
import type { SlideshowMediaItem } from '@/types/effects/background';
import { loadProjectFromIDB } from '@/utils/indexedDB';
import { isDeadBlobUrl, stripDeadBlobItems } from '@/utils/deadBlobUrls';
import { createLogger } from '@/utils/logger';
import { ThrenicProject } from '@/types/project';
import { toast } from '@/utils';

const logger = createLogger({ enabled: true, prefix: 'ProjectRestore' });

interface UseProjectRestoreProps {
  onRestore: (project: ThrenicProject, tracks: Track[]) => void;
}

export function useProjectRestore({ onRestore }: UseProjectRestoreProps): {
  isRestored: boolean;
} {
  const [isRestored, setIsRestored] = useState(false);

  useEffect(() => {
    if (isRestored) return;

    async function restore(): Promise<void> {
      try {
        const saved = await loadProjectFromIDB();
        if (!saved) return;

        const { project, assets } = saved;
        if (!project.theme || !project.animation || !project.effects) return;

        // Every blob: URL minted this session is recorded here so the
        // dead-blob strip at the end can distinguish live URLs from stale
        // carry-over strings persisted by a previous session.
        const liveBlobUrls = new Set<string>();
        const mintBlobUrl = (blob: Blob): string => {
          const u = URL.createObjectURL(blob);
          liveBlobUrls.add(u);
          return u;
        };

        if (assets?.['__GLOBAL__']) {
          const globalAsset = assets['__GLOBAL__'];
          if (globalAsset.backgroundImageFile && project.effects?.pixi) {
            const blob = globalAsset.backgroundImageFile;
            if (blob instanceof Blob) {
              project.effects.pixi.image = URL.createObjectURL(blob);
            }
          }

          // Restore Global Grain Bundles
          if (globalAsset.grainBundle && Array.isArray(globalAsset.grainBundle)) {
            const newUrls = globalAsset.grainBundle.map((blob) => URL.createObjectURL(blob));
            if (project.effects?.postProcessing?.oldFilm?.grainBundle) {
              project.effects.postProcessing.oldFilm.grainBundle = newUrls;
            }
            if (project.effects?.postProcessing?.noiseOverlay?.grainBundle) {
              project.effects.postProcessing.noiseOverlay.grainBundle = newUrls;
            }
          }

          // Restore Global Slideshow Media
          if (
            globalAsset.slideshowMedia &&
            globalAsset.slideshowMedia.length > 0 &&
            project.effects?.slideshow
          ) {
            project.effects.slideshow.items = globalAsset.slideshowMedia.map((stored) => ({
              id: stored.id,
              type: stored.type,
              label: stored.label,
              url: mintBlobUrl(stored.blob),
            }));
          }
        }

        // Strip stale blob: URLs from the GLOBAL slideshow items that were not
        // re-minted from a live Blob above (dead carry-overs from a prior session).
        if (project.effects?.slideshow?.items && Array.isArray(project.effects.slideshow.items)) {
          const cleaned = stripDeadBlobItems(project.effects.slideshow.items, liveBlobUrls);
          if (cleaned.length !== project.effects.slideshow.items.length) {
            logger.info(
              `Stripped ${project.effects.slideshow.items.length - cleaned.length} dead-blob item(s) from global slideshow`,
            );
            project.effects.slideshow.items = cleaned;
          }
        }

        if (project.playlist && Array.isArray(project.playlist) && project.playlist.length > 0) {
          const restoredTracks: Track[] = await Promise.all(
            project.playlist.map(async (t) => {
              const assetData = assets?.[t.id] || {};
              let audioUrl = '';
              if (assetData.audioFile) audioUrl = URL.createObjectURL(assetData.audioFile);
              let backgroundImage: string | undefined = undefined;
              if (assetData.backgroundImageFile) {
                backgroundImage = mintBlobUrl(assetData.backgroundImageFile);
              }

              // Restore grain bundle blob URLs
              const trackEffects = t.effectsConfig
                ? JSON.parse(JSON.stringify(t.effectsConfig))
                : t.effectsConfig;
              if (assetData.grainBundle && Array.isArray(assetData.grainBundle) && trackEffects) {
                const newUrls = assetData.grainBundle.map((blob) => URL.createObjectURL(blob));
                if (trackEffects.postProcessing?.oldFilm?.grainBundle) {
                  trackEffects.postProcessing.oldFilm.grainBundle = newUrls;
                }
                if (trackEffects.postProcessing?.noiseOverlay?.grainBundle) {
                  trackEffects.postProcessing.noiseOverlay.grainBundle = newUrls;
                }
              }

              // Restore keyframe scene.assetUrl blob URLs from persisted images
              let restoredKeyframes = t.keyframes ? [...t.keyframes] : [];
              if (
                assetData.keyframeImages &&
                assetData.keyframeImages.length > 0 &&
                assetData.keyframeImageUrlMap &&
                restoredKeyframes.length > 0
              ) {
                const oldUrlToNewUrl: Record<string, string> = {};
                for (const [oldUrl, idx] of Object.entries(assetData.keyframeImageUrlMap)) {
                  const blob = assetData.keyframeImages[idx];
                  if (blob) {
                    oldUrlToNewUrl[oldUrl] = mintBlobUrl(blob);
                  }
                }

                restoredKeyframes = restoredKeyframes.map((kf) => {
                  const assetUrl = kf.properties?.['scene.assetUrl'];
                  if (typeof assetUrl === 'string' && assetUrl in oldUrlToNewUrl) {
                    return {
                      ...kf,
                      properties: {
                        ...kf.properties,
                        'scene.assetUrl': oldUrlToNewUrl[assetUrl],
                      },
                    };
                  }
                  return kf;
                });
              }

              // Restore per-track slideshow media blob URLs
              const oldUrlToNewUrl: Record<string, string> = {};
              if (assetData.slideshowMedia && assetData.slideshowMedia.length > 0) {
                const restoredItems = assetData.slideshowMedia.map((stored) => {
                  const newUrl = mintBlobUrl(stored.blob);
                  if (stored.originalUrl) {
                    oldUrlToNewUrl[stored.originalUrl] = newUrl;
                  }
                  return {
                    id: stored.id,
                    type: stored.type,
                    label: stored.label,
                    url: newUrl,
                  };
                });

                if (trackEffects?.slideshow) {
                  trackEffects.slideshow = {
                    ...trackEffects.slideshow,
                    items: restoredItems,
                  };
                }
                if (!backgroundImage && restoredItems.length > 0) {
                  backgroundImage = restoredItems[0].url;
                }
              }

              // Strip stale blob: URLs from slideshow items that were NOT
              // re-minted from a live Blob this session (dead after reload).
              if (trackEffects?.slideshow?.items && Array.isArray(trackEffects.slideshow.items)) {
                const cleaned = stripDeadBlobItems<SlideshowMediaItem>(
                  trackEffects.slideshow.items,
                  liveBlobUrls,
                );
                if (cleaned.length !== trackEffects.slideshow.items.length) {
                  logger.info(
                    `Stripped ${trackEffects.slideshow.items.length - cleaned.length} dead-blob slideshow item(s) from track "${t.name}"`,
                  );
                  trackEffects.slideshow = { ...trackEffects.slideshow, items: cleaned };
                }
                // If the picked backgroundImage pointed at a now-stripped dead blob, fix it.
                if (backgroundImage && isDeadBlobUrl(backgroundImage, liveBlobUrls)) {
                  backgroundImage = cleaned.length > 0 ? cleaned[0].url : undefined;
                }
              }

              // Restore/remap track videoClips using new blob URLs
              let finalClips = t.videoClips ? [...t.videoClips] : [];
              if (finalClips.length > 0) {
                finalClips = finalClips.map((clip) => {
                  if (clip.url in oldUrlToNewUrl) {
                    return {
                      ...clip,
                      url: oldUrlToNewUrl[clip.url],
                    };
                  }
                  return clip;
                });
                // Remove clips with dead/unreachable URLs (e.g. deprecated sample videos)
                finalClips = finalClips.filter((clip) => {
                  if (!clip.url) return false;
                  // Stale blob: URL carried over from a prior session — dead after reload.
                  if (isDeadBlobUrl(clip.url, liveBlobUrls)) return false;
                  if (clip.url.includes('gtv-videos-bucket/sample/TearsOfSteel')) return false;
                  if (clip.url.includes('commondatastorage.googleapis.com/gtv-videos'))
                    return false;
                  return true;
                });
              } else {
                const slideItems = trackEffects?.slideshow?.items || [];
                if (slideItems.length > 0) {
                  let accTime = 0;
                  const clipDuration =
                    typeof t.duration === 'number' && t.duration > 0
                      ? t.duration / slideItems.length
                      : 5.0;
                  finalClips = slideItems.map((item: SlideshowMediaItem, idx: number) => {
                    const start = accTime;
                    const end = accTime + clipDuration;
                    accTime = end;
                    return {
                      id: crypto.randomUUID(),
                      name: item.label || `Media ${idx + 1}`,
                      url: item.url,
                      startTime: start,
                      endTime: end,
                      inPoint: 0,
                      outPoint: clipDuration,
                      sourceDuration: clipDuration,
                      speed: 1.0,
                      behavior: item.type === 'video' ? 'loop' : 'pause',
                      opacity: 1.0,
                      scale: 1.0,
                      brightness: 1.0,
                      offsetX: 0,
                      offsetY: 0,
                    };
                  });
                } else if (trackEffects?.video?.url && trackEffects.video.enabled) {
                  const url = trackEffects.video.url;
                  finalClips.push({
                    id: 'default_video_clip',
                    name: 'Background Video',
                    url,
                    startTime: 0,
                    endTime: t.duration,
                    inPoint: 0,
                    outPoint: t.duration,
                    sourceDuration: t.duration,
                    speed: 1.0,
                    behavior: 'loop',
                    opacity: 1.0,
                    scale: 1.0,
                    brightness: 1.0,
                    offsetX: 0,
                    offsetY: 0,
                  });
                } else if (backgroundImage) {
                  finalClips.push({
                    id: 'default_image_clip',
                    name: 'Background Image',
                    url: backgroundImage,
                    startTime: 0,
                    endTime: t.duration,
                    inPoint: 0,
                    outPoint: t.duration,
                    sourceDuration: t.duration,
                    speed: 1.0,
                    behavior: 'pause',
                    opacity: 1.0,
                    scale: 1.0,
                    brightness: 1.0,
                    offsetX: 0,
                    offsetY: 0,
                  });
                }
              }

              return {
                id: t.id,
                name: t.name,
                artist: t.artist,
                duration: t.duration,
                audioUrl,
                audioFile: assetData.audioFile,
                audioFilePath: t.audioFilePath || undefined,
                backgroundImage,
                backgroundImageFilePath: t.backgroundImageFilePath || undefined,
                lyricsData: t.lyrics,
                lyricsFilePath: t.lyricsFilePath || undefined,
                effectsConfig: trackEffects,
                lyricsTheme: t.lyricsTheme,
                keyframes: restoredKeyframes,
                videoClips: finalClips,
              } as Track;
            }),
          );

          const validTracks = restoredTracks.filter((t) => t.audioUrl && t.audioUrl.length > 0);
          onRestore(project, validTracks);
          if (validTracks.length > 0) {
            toast.success(
              `Restored project: ${project.meta?.name || 'Untitled'} (${validTracks.length} tracks)`,
            );
          }
        } else {
          onRestore(project, []);
          toast.success(`Restored project: ${project.meta?.name || 'Untitled'}`);
        }
      } catch (error) {
        logger.error('Failed to restore project:', error as Error);
      } finally {
        setIsRestored(true);
      }
    }

    restore();
  }, [isRestored, onRestore]);

  return { isRestored };
}
