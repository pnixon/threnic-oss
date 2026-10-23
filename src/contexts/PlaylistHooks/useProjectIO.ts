import { useCallback } from 'react';
import type { Track, TrackExportData } from '@/contexts/types';
import type {
  ThrenicProject,
  ProjectExportManifest,
  TrackManifest,
  PlaylistSettings,
} from '@/types/project';

import { createLogger } from '@/utils/logger';
import { generateTrackId, getAudioDuration, getAudioBuffer } from '@/contexts/utils';
import { loadProject } from '@/utils/project';
import { migrateLegacyEffects } from '@/utils/effects-migration';
import { toast } from '@/utils/toast';
import type { LyricLineData, Word } from '@/types/lyrics';
import { DEFAULT_LYRICS_THEME } from '@/types/lyrics';
import type { VideoClip } from '@/types/video-clips';
import { projectStore } from '@/stores/projectStore';

const logger = createLogger({ enabled: true, prefix: 'ProjectIO' });
/**
 * useProjectIO — project import/export.
 *
 * Reads/writes projectStore directly. No props needed.
 */
export function useProjectIO() {
  const getTracksForExport = useCallback(async function (
    trackIds: string[],
  ): Promise<TrackExportData[]> {
    const tracks = projectStore.getState().tracks;
    const selectedTracks =
      trackIds.length > 0 ? tracks.filter((t) => trackIds.includes(t.id)) : tracks;

    const orderedTracks =
      trackIds.length > 0
        ? trackIds.map((id) => selectedTracks.find((t) => t.id === id)!).filter(Boolean)
        : selectedTracks;

    const exportDataPromises = orderedTracks.map(
      async function (track): Promise<TrackExportData | null> {
        try {
          const buffer = await getAudioBuffer(track.audioUrl);
          return {
            trackId: track.id,
            audioBuffer: buffer,
            duration: Math.max(track.duration, buffer.duration),
            lyrics: track.lyricsData || [],
            backgroundImage: track.backgroundImage,
            effectsConfig: track.effectsConfig,
            lyricsTheme: track.lyricsTheme,
            keyframes: track.keyframes || [],
            name: track.name,
          };
        } catch (error) {
          logger.error(`Failed to load buffer for track ${track.name}`, error as Error);
          return null;
        }
      },
    );

    const results = await Promise.all(exportDataPromises);
    return results.filter((r): r is TrackExportData => r !== null);
  }, []);

  const exportCurrentProject = useCallback(function (): {
    tracks: Track[];
    settings: PlaylistSettings;
  } {
    const { tracks, settings } = projectStore.getState();
    return { tracks, settings };
  }, []);

  const convertProjectToManifest = useCallback(function (
    project: ThrenicProject,
  ): ProjectExportManifest {
    const manifestTracks: TrackManifest[] = [];

    if (project.playlist && project.playlist.length > 0) {
      // Modern Multi-track project
      for (const t of project.playlist) {
        manifestTracks.push({
          id: t.id,
          name: t.name,
          artist: t.artist,
          duration: t.duration,
          audioFilePath: t.audioFilePath || '',
          backgroundImageFilePath: t.backgroundImageFilePath,
          lyricsFilePath: t.lyricsFilePath,
          lyrics: t.lyrics,
          effectsConfig: t.effectsConfig,
          lyricsTheme: t.lyricsTheme,
          keyframes: t.keyframes,
          videoClips: t.videoClips || [],
        });
      }
    } else {
      // Legacy or Single-track project root format
      manifestTracks.push({
        id: generateTrackId(),
        name: project.meta.name,
        artist: project.meta.artist,
        duration: 0, // Will be calculated during load
        audioFilePath: project.audio.filePath || '',
        backgroundImageFilePath: project.backgroundImage.filePath,
        lyricsFilePath: project.lyrics.filePath,
        lyrics: project.lyrics.lines,
        effectsConfig: project.effects,
        keyframes: [],
        videoClips: (project as ThrenicProject & { videoClips?: VideoClip[] }).videoClips || [],
      });
    }

    return {
      version: project.version,
      meta: {
        name: project.meta.name,
        artist: project.meta.artist,
        created: project.meta.createdAt,
        modified: project.meta.modifiedAt,
      },
      theme: {
        glowEnabled: false,
        glowColor: '#d946ef',
        glowIntensity: 0.5,
        outlineColor: '#000000',
        fadeInDuration: 1.0,
        fadeOutDuration: 1.0,
        highlightFadeIn: 1.0,
        highlightFadeOut: 1.0,
        ...project.theme,
      },
      animation: project.animation,
      effects: project.effects,
      exportSettings: project.exportSettings,
      playlistSettings: project.playlistSettings,
      tracks: manifestTracks,
    };
  }, []);

  const loadProjectFromManifest = useCallback(async function (
    manifest: ProjectExportManifest,
    assets?: Map<string, Blob>,
  ): Promise<void> {
    projectStore.setState({ isLoading: true });
    try {
      const loadedTracks: Track[] = [];

      for (const trackManifest of manifest.tracks) {
        const audioAsset = assets?.get(`audio_${trackManifest.id}`);
        let audioUrl = '';
        let audioFile: Blob | undefined;

        if (audioAsset) {
          audioUrl = URL.createObjectURL(audioAsset);
          audioFile = audioAsset;
        } else if (trackManifest.audioFilePath) {
          try {
            const response = await fetch(trackManifest.audioFilePath);
            if (response.ok) {
              const blob = await response.blob();
              audioUrl = URL.createObjectURL(blob);
              audioFile = blob;
            }
          } catch (error) {
            logger.warn(`Failed to load audio for track ${trackManifest.name}`, error as Error);
            continue;
          }
        }

        if (!audioUrl) {
          logger.warn(`No audio URL for track ${trackManifest.name}`);
          continue;
        }

        const bgAsset = assets?.get(`background_${trackManifest.id}`);
        let backgroundImage: string | undefined;
        let backgroundImageFile: Blob | undefined;

        if (bgAsset) {
          backgroundImage = URL.createObjectURL(bgAsset);
          backgroundImageFile = bgAsset;
        } else if (trackManifest.backgroundImageFilePath) {
          try {
            const response = await fetch(trackManifest.backgroundImageFilePath);
            if (response.ok) {
              const blob = await response.blob();
              backgroundImage = URL.createObjectURL(blob);
              backgroundImageFile = blob;
            }
          } catch (error) {
            logger.warn(
              `Failed to load background for track ${trackManifest.name}`,
              error as Error,
            );
          }
        }

        let lyricsData: LyricLineData[] | undefined = trackManifest.lyrics;
        if (!lyricsData && trackManifest.lyricsFilePath) {
          try {
            const response = await fetch(trackManifest.lyricsFilePath);
            if (response.ok) {
              const data = await response.json();
              const rawLyrics = Array.isArray(data) ? data : data.lyrics;

              if (Array.isArray(rawLyrics) && rawLyrics.length > 0 && Array.isArray(rawLyrics[0])) {
                lyricsData = (rawLyrics as Word[][]).map(
                  function (lineWords, index): LyricLineData {
                    const words: Word[] = lineWords.map((w): Word => {
                      return { text: w.text, start: w.start, end: w.end };
                    });
                    const startTime = words[0]?.start ?? 0;
                    const endTime = words[words.length - 1]?.end ?? 0;
                    const text = words.map((w) => w.text).join(' ');
                    return { id: `line-${index}`, text, start: startTime, end: endTime, words };
                  },
                );
              } else {
                lyricsData = rawLyrics as LyricLineData[];
              }
            }
          } catch (error) {
            logger.warn(`Failed to load lyrics for track ${trackManifest.name}`, error as Error);
          }
        }

        const duration = trackManifest.duration || (await getAudioDuration(audioUrl));

        // Restore grain bundles for per-track effects
        const { config: migratedConfig, keyframes: migratedKeyframes } = migrateLegacyEffects(
          trackManifest.effectsConfig,
          trackManifest.keyframes,
        );

        if (migratedConfig.postProcessing?.oldFilm?.grainBundle) {
          migratedConfig.postProcessing.oldFilm.grainBundle =
            migratedConfig.postProcessing.oldFilm.grainBundle.map((url, i) => {
              const asset = assets?.get(`grain_oldFilm_${trackManifest.id}_${i}`);
              return asset ? URL.createObjectURL(asset) : url;
            });
        }
        if (migratedConfig.postProcessing?.noiseOverlay?.grainBundle) {
          migratedConfig.postProcessing.noiseOverlay.grainBundle =
            migratedConfig.postProcessing.noiseOverlay.grainBundle.map((url, i) => {
              const asset = assets?.get(`grain_noise_${trackManifest.id}_${i}`);
              return asset ? URL.createObjectURL(asset) : url;
            });
        }

        // Video URLs given as server-relative paths are left as-is so the browser
        // streams them; fetching a large MP4 as a blob is slow and wastes memory.

        // Remap keyframe scene.assetUrl blob URLs using asset map entries
        // Assets are keyed as `kfImage_<trackId>_<origUrl>` (URL used as key suffix)
        let finalKeyframes = migratedKeyframes ? [...migratedKeyframes] : [];
        if (assets && finalKeyframes.length > 0) {
          const kfUrlRemap: Record<string, string> = {};
          assets.forEach((blob, key) => {
            if (key.startsWith(`kfImage_${trackManifest.id}_`)) {
              const origUrl = key.slice(`kfImage_${trackManifest.id}_`.length);
              kfUrlRemap[origUrl] = URL.createObjectURL(blob);
            }
          });

          if (Object.keys(kfUrlRemap).length > 0) {
            finalKeyframes = finalKeyframes.map((kf) => {
              const assetUrl = kf.properties?.['scene.assetUrl'];
              if (typeof assetUrl === 'string' && assetUrl in kfUrlRemap) {
                return {
                  ...kf,
                  properties: {
                    ...kf.properties,
                    'scene.assetUrl': kfUrlRemap[assetUrl],
                  },
                };
              }
              return kf;
            });
          }
        }

        // Convert embedded data: URLs to blob URLs for efficient runtime use
        // (data: URLs are self-contained but large; blob: URLs are faster to reference)
        if (finalKeyframes.length > 0) {
          const dataUrlToBlobUrl: Record<string, string> = {};
          finalKeyframes = finalKeyframes.map((kf) => {
            const assetUrl = kf.properties?.['scene.assetUrl'];
            if (typeof assetUrl === 'string' && assetUrl.startsWith('data:')) {
              if (!(assetUrl in dataUrlToBlobUrl)) {
                try {
                  // Convert data URL to blob URL
                  const arr = assetUrl.split(',');
                  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
                  const bstr = atob(arr[1]);
                  const n = bstr.length;
                  const u8arr = new Uint8Array(n);
                  for (let j = 0; j < n; j++) u8arr[j] = bstr.charCodeAt(j);
                  const blob = new Blob([u8arr], { type: mime });
                  dataUrlToBlobUrl[assetUrl] = URL.createObjectURL(blob);
                } catch {
                  // Leave as data URL if conversion fails
                }
              }
              const newUrl = dataUrlToBlobUrl[assetUrl];
              if (newUrl) {
                return {
                  ...kf,
                  properties: { ...kf.properties, 'scene.assetUrl': newUrl },
                };
              }
            }
            return kf;
          });
        }

        // Convert server-relative paths (e.g. /Me Angry.png) to blob URLs
        // These raw paths can fail as Three.js texture URLs, especially with spaces.
        if (finalKeyframes.length > 0) {
          const pathToBlobUrl: Record<string, string> = {};
          const pathConversions: Promise<void>[] = [];

          // Collect unique paths that need fetching
          for (const kf of finalKeyframes) {
            const assetUrl = kf.properties?.['scene.assetUrl'];
            if (
              typeof assetUrl === 'string' &&
              assetUrl.startsWith('/') &&
              !assetUrl.startsWith('//') &&
              !(assetUrl in pathToBlobUrl)
            ) {
              pathToBlobUrl[assetUrl] = ''; // placeholder
              pathConversions.push(
                fetch(assetUrl)
                  .then((r) => (r.ok ? r.blob() : null))
                  .then((blob) => {
                    if (blob) {
                      pathToBlobUrl[assetUrl] = URL.createObjectURL(blob);
                    }
                  })
                  .catch(() => {
                    // Leave empty - will fall back to raw path
                  }),
              );
            }
          }

          if (pathConversions.length > 0) {
            await Promise.all(pathConversions);

            finalKeyframes = finalKeyframes.map((kf) => {
              const assetUrl = kf.properties?.['scene.assetUrl'];
              if (typeof assetUrl === 'string' && pathToBlobUrl[assetUrl]) {
                return {
                  ...kf,
                  properties: { ...kf.properties, 'scene.assetUrl': pathToBlobUrl[assetUrl] },
                };
              }
              return kf;
            });
          }
        }

        // Convert server-relative paths in effectsConfig.slideshow.items[].url
        // and effectsConfig.video.url to blob URLs so Three.js TextureLoader
        // can load them reliably (avoids failures with spaces in filenames etc.)
        if (migratedConfig.slideshow?.items && migratedConfig.slideshow.items.length > 0) {
          const slideshowPathMap: Record<string, string> = {};
          const slideshowFetches: Promise<void>[] = [];

          for (const item of migratedConfig.slideshow.items) {
            if (
              typeof item.url === 'string' &&
              item.url.startsWith('/') &&
              !item.url.startsWith('//') &&
              // Skip large video files — they should be streamed, not blob-ified
              !/\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(item.url)
            ) {
              if (!(item.url in slideshowPathMap)) {
                slideshowPathMap[item.url] = ''; // placeholder
                const origUrl = item.url;
                slideshowFetches.push(
                  fetch(origUrl)
                    .then((r) => (r.ok ? r.blob() : null))
                    .then((blob) => {
                      if (blob) slideshowPathMap[origUrl] = URL.createObjectURL(blob);
                    })
                    .catch(() => {}),
                );
              }
            }
          }

          if (slideshowFetches.length > 0) {
            await Promise.all(slideshowFetches);
            migratedConfig.slideshow = {
              ...migratedConfig.slideshow,
              items: migratedConfig.slideshow.items.map((item) => {
                const blobUrl = slideshowPathMap[item.url];
                return blobUrl ? { ...item, url: blobUrl } : item;
              }),
            };
          }
        }

        // Convert server-relative video.url to blob URL (stream-friendly path kept as-is for MP4)
        // Only convert short-form image/video paths, not the large streaming video files
        if (
          migratedConfig.video?.url &&
          typeof migratedConfig.video.url === 'string' &&
          migratedConfig.video.url.startsWith('/') &&
          !migratedConfig.video.url.startsWith('//') &&
          !/\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(migratedConfig.video.url)
        ) {
          try {
            const r = await fetch(migratedConfig.video.url);
            if (r.ok) {
              const blob = await r.blob();
              migratedConfig.video = {
                ...migratedConfig.video,
                url: URL.createObjectURL(blob),
              };
            }
          } catch {
            // Leave as-is if fetch fails
          }
        }

        // ── Clean up any unmapped dead blob: URLs ──
        const originPrefix = typeof window !== 'undefined' ? `blob:${window.location.origin}` : '';
        if (originPrefix) {
          if (
            backgroundImage &&
            backgroundImage.startsWith('blob:') &&
            !backgroundImage.startsWith(originPrefix)
          ) {
            backgroundImage = undefined;
          }
          if (
            migratedConfig.video?.url &&
            typeof migratedConfig.video.url === 'string' &&
            migratedConfig.video.url.startsWith('blob:') &&
            !migratedConfig.video.url.startsWith(originPrefix)
          ) {
            migratedConfig.video.url = '';
            migratedConfig.video.enabled = false;
          }
          if (migratedConfig.slideshow?.items) {
            migratedConfig.slideshow.items = migratedConfig.slideshow.items.map((item) => {
              if (
                typeof item.url === 'string' &&
                item.url.startsWith('blob:') &&
                !item.url.startsWith(originPrefix)
              ) {
                return { ...item, url: '' };
              }
              return item;
            });
          }
          if (finalKeyframes.length > 0) {
            finalKeyframes = finalKeyframes.map((kf) => {
              const assetUrl = kf.properties?.['scene.assetUrl'];
              if (
                typeof assetUrl === 'string' &&
                assetUrl.startsWith('blob:') &&
                !assetUrl.startsWith(originPrefix)
              ) {
                const nextProps = { ...kf.properties };
                delete nextProps['scene.assetUrl'];
                return { ...kf, properties: nextProps };
              }
              return kf;
            });
          }
        }

        if (trackManifest.audioFilePath?.startsWith('blob:')) {
          trackManifest.audioFilePath = '';
        }
        if (trackManifest.backgroundImageFilePath?.startsWith('blob:')) {
          trackManifest.backgroundImageFilePath = null;
        }

        // Synthesize videoClips and keyframes for legacy/default formats
        let finalClips = trackManifest.videoClips ? [...trackManifest.videoClips] : [];
        if (originPrefix && finalClips.length > 0) {
          finalClips = finalClips.map((clip) => {
            if (clip.url && clip.url.startsWith('blob:') && !clip.url.startsWith(originPrefix)) {
              return { ...clip, url: '' };
            }
            return clip;
          });
        }

        if (finalClips.length === 0) {
          const slideItems = migratedConfig.slideshow?.items || [];
          if (slideItems.length > 0) {
            let accTime = 0;
            const clipDuration =
              typeof duration === 'number' && duration > 0 ? duration / slideItems.length : 5.0;
            finalClips = slideItems.map((item, idx) => {
              let clipDur = clipDuration;
              if (item.type === 'image' && item.duration !== undefined) {
                clipDur = item.duration;
              } else if (
                item.type === 'video' &&
                item.overrideDuration &&
                item.duration !== undefined
              ) {
                clipDur = item.duration;
              }
              const start = accTime;
              const end = accTime + clipDur;
              accTime = end;
              return {
                id: crypto.randomUUID(),
                name: item.label || `Media ${idx + 1}`,
                url: item.url,
                startTime: start,
                endTime: end,
                inPoint: 0,
                outPoint: clipDur,
                sourceDuration: clipDur,
                speed: 1.0,
                behavior: item.type === 'video' ? 'loop' : 'pause',
                overrideDuration: item.overrideDuration,
                duration: item.duration,
              };
            });

            if (finalKeyframes.length === 0) {
              finalKeyframes = finalClips.map((clip) => ({
                id: crypto.randomUUID(),
                time: clip.startTime,
                interpolation: 'linear',
                properties: {
                  'scene.assetUrl': clip.url,
                  ...(clip.startTime > 0
                    ? {
                        transition: {
                          type: 'crossfade',
                          duration: 1.0,
                        },
                      }
                    : {}),
                },
              }));
            }
          } else if (migratedConfig.video?.url && migratedConfig.video.enabled) {
            const url = migratedConfig.video.url;
            finalClips.push({
              id: 'default_video_clip',
              name: 'Background Video',
              url,
              startTime: 0,
              endTime: duration,
              inPoint: 0,
              outPoint: duration,
              sourceDuration: duration,
              speed: 1.0,
              behavior: 'loop',
            });

            if (finalKeyframes.length === 0) {
              finalKeyframes.push({
                id: 'default_scene_kf',
                time: 0,
                interpolation: 'linear',
                properties: {
                  'scene.assetUrl': url,
                },
              });
            }
          } else if (backgroundImage) {
            finalClips.push({
              id: 'default_image_clip',
              name: 'Background Image',
              url: backgroundImage,
              startTime: 0,
              endTime: duration,
              inPoint: 0,
              outPoint: duration,
              sourceDuration: duration,
              speed: 1.0,
              behavior: 'pause',
            });

            if (finalKeyframes.length === 0) {
              finalKeyframes.push({
                id: 'default_scene_kf',
                time: 0,
                interpolation: 'linear',
                properties: {
                  'scene.assetUrl': backgroundImage,
                },
              });
            }
          }
        }

        loadedTracks.push({
          id: trackManifest.id,
          name: trackManifest.name,
          artist: trackManifest.artist,
          duration,
          audioUrl,
          audioFile,
          audioFilePath: trackManifest.audioFilePath,
          backgroundImage,
          backgroundImageFile,
          backgroundImageFilePath: trackManifest.backgroundImageFilePath || undefined,
          lyricsData,
          lyricsFilePath: trackManifest.lyricsFilePath || undefined,
          effectsConfig: migratedConfig,
          lyricsTheme: { ...DEFAULT_LYRICS_THEME, ...trackManifest.lyricsTheme },
          keyframes: finalKeyframes,
          videoClips: finalClips,
        });
      }

      if (loadedTracks.length > 0) {
        projectStore.getState().restorePlaylist(loadedTracks);
        if (manifest.playlistSettings) {
          projectStore.getState().updateSettings(manifest.playlistSettings);
        }
      }
    } catch (error) {
      logger.error('Failed to load project from manifest:', error as Error);
      throw error;
    } finally {
      projectStore.setState({ isLoading: false });
    }
  }, []);

  const importProject = useCallback(
    async function (): Promise<void> {
      try {
        const result = await loadProject();
        if (!result) return;

        const manifest = convertProjectToManifest(result.project);
        await loadProjectFromManifest(manifest);
        toast.success('Project imported successfully');
      } catch (error) {
        logger.error('Failed to import project:', error as Error);
        toast.error('Failed to import project');
      }
    },
    [loadProjectFromManifest, convertProjectToManifest],
  );

  return {
    getTracksForExport,
    exportCurrentProject,
    loadProjectFromManifest,
    importProject,
    convertProjectToManifest,
  };
}
