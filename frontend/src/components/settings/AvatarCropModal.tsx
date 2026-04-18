import { useState, useCallback, useEffect } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import { cn } from '../../utils/cn';

/**
 * Avatar crop + client-side optimize modal. Issue #447.
 *
 * Pipeline:
 *  1. Raw file (any size) → object URL fed into <Cropper/>
 *  2. User pans + zooms → `onCropComplete` yields croppedAreaPixels
 *  3. "Tamam" → draw cropped region onto offscreen canvas, scaled to
 *     `OUTPUT_PX` (default 512) and encoded as JPEG q=0.85 data URL.
 *  4. Parent receives the compact data URL and ships it to
 *     `PUT /auth/avatar`.
 *
 * Canvas scaling handles both downscale (iPhone photos) and upscale
 * (crop region smaller than OUTPUT_PX). Output kept ≤ ~200KB in practice.
 */

const OUTPUT_PX = 512;
const JPEG_QUALITY = 0.85;

interface Props {
  /** Source image (object URL or data URL). */
  imageSrc: string;
  /** Invoked with the optimized data URL when the user confirms. */
  onConfirm: (dataUrl: string) => void | Promise<void>;
  /** Invoked when the user cancels or dismisses the modal. */
  onCancel: () => void;
  /** Disable controls while parent is uploading. */
  busy?: boolean;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    // Data URLs and same-origin object URLs don't need CORS; setting
    // crossOrigin on an object URL throws in some browsers.
    img.src = src;
  });
}

/**
 * Render the selected crop region onto a canvas sized to OUTPUT_PX and
 * return a JPEG data URL. JPEG chosen for broad avatar support and small
 * payload — transparency isn't needed for a square/round portrait.
 */
async function cropToDataUrl(src: string, area: Area): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_PX;
  canvas.height = OUTPUT_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  // Solid neutral backdrop so the JPEG has no ghost transparency.
  ctx.fillStyle = '#0A1215';
  ctx.fillRect(0, 0, OUTPUT_PX, OUTPUT_PX);
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    OUTPUT_PX,
    OUTPUT_PX,
  );
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

export default function AvatarCropModal({ imageSrc, onConfirm, onCancel, busy = false }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !processing) onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [busy, processing, onCancel]);

  const handleConfirm = async () => {
    if (!croppedAreaPixels || busy || processing) return;
    setProcessing(true);
    try {
      const dataUrl = await cropToDataUrl(imageSrc, croppedAreaPixels);
      await onConfirm(dataUrl);
    } catch {
      // Parent is responsible for user-facing toasts; log silently here.
      setProcessing(false);
    }
  };

  const disabled = busy || processing;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Profil resmi kırp"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ak-bg/95 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-ak-border bg-ak-surface p-4 shadow-2xl">
        <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
          Profil resmini kırp
        </h2>

        {/* Crop surface (aspect 1:1, round overlay) */}
        <div className="relative mb-4 aspect-square w-full overflow-hidden rounded-xl bg-black">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            minZoom={1}
            maxZoom={3}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        {/* Zoom slider */}
        <div className="mb-4">
          <label
            htmlFor="avatar-crop-zoom"
            className="mb-1.5 block text-[11px] font-medium text-ak-text-secondary"
          >
            Yakınlaştır
          </label>
          <input
            id="avatar-crop-zoom"
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            disabled={disabled}
            aria-label="Yakınlaştırma seviyesi"
            className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ak-surface-2 accent-ak-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className={cn(
              'rounded-lg px-3 py-2 text-xs font-medium text-ak-text-secondary',
              'hover:bg-ak-surface-2 hover:text-ak-text-primary transition-colors',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            Vazgeç
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={disabled || !croppedAreaPixels}
            className={cn(
              'rounded-lg bg-ak-primary px-3 py-2 text-xs font-medium text-[color:var(--ak-on-primary)]',
              (disabled || !croppedAreaPixels) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {processing || busy ? 'Yükleniyor…' : 'Tamam'}
          </button>
        </div>
      </div>
    </div>
  );
}
