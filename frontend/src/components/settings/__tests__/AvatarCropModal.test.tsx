/**
 * AvatarCropModal — issue #447.
 *
 * Covers:
 *  - Modal renders with provided image source
 *  - Escape key fires onCancel (unless busy)
 *  - Zoom slider disabled while busy
 *  - Confirm button calls onConfirm with a data URL derived from canvas
 *  - Cancel button fires onCancel
 *
 * `react-easy-crop` is mocked because jsdom lacks the layout + pointer
 * APIs it relies on; we simulate its `onCropComplete` callback so the
 * data-URL path can be exercised end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import AvatarCropModal from '../AvatarCropModal';

// ---------- Mocks ----------

/**
 * Minimal stand-in for <Cropper/>. It emits a crop area in a useEffect so
 * the confirm button becomes enabled after the first commit, mirroring the
 * production component's behaviour without dragging in react-easy-crop's
 * DOM assumptions.
 */
function MockCropper({ onCropComplete }: { onCropComplete?: (a: unknown, p: unknown) => void }) {
  useEffect(() => {
    onCropComplete?.(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 10, width: 200, height: 200 },
    );
    // Only emit once — we don't need a dep array reactivity chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div data-testid="mock-cropper" />;
}

vi.mock('react-easy-crop', () => ({
  __esModule: true,
  default: MockCropper,
}));

// Stub out canvas + Image so the JPEG encoding path runs in jsdom.
beforeEach(() => {
  vi.restoreAllMocks();

  // HTMLCanvasElement.prototype.toDataURL — jsdom returns '' by default.
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,AAAA');
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  })) as unknown as HTMLCanvasElement['getContext'];

  // Image onload fires synchronously for data/object URLs. We use setTimeout
  // instead of queueMicrotask because the modal awaits the Image load after
  // event handlers have already run — microtasks can deadlock against
  // vitest's fake timer / act scheduling.
  Object.defineProperty(global, 'Image', {
    writable: true,
    configurable: true,
    value: class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = '';
      set src(value: string) {
        this._src = value;
        setTimeout(() => this.onload?.(), 0);
      }
      get src() {
        return this._src;
      }
    },
  });
});

describe('AvatarCropModal', () => {
  it('renders the cropper with the given image', () => {
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mock-cropper')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('fires onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText('Vazgeç'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when Escape is pressed and not busy', () => {
    const onCancel = vi.fn();
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not fire onCancel on Escape while busy', () => {
    const onCancel = vi.fn();
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={onCancel}
        busy
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('confirm produces a JPEG data URL and forwards it to onConfirm', async () => {
    const onConfirm = vi.fn();
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Wait for the mock cropper to emit its crop area (enables the button).
    await waitFor(() => {
      const btn = screen.getByText('Tamam').closest('button');
      expect(btn).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Tamam'));
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/^data:image\/jpeg;base64,/),
      );
    });
  });

  it('disables the zoom slider while busy', () => {
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy
      />,
    );
    const slider = screen.getByLabelText('Yakınlaştırma seviyesi') as HTMLInputElement;
    expect(slider).toBeDisabled();
  });

  it('shows "Yükleniyor…" on the confirm button while busy', () => {
    render(
      <AvatarCropModal
        imageSrc="blob:fake"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy
      />,
    );
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
  });
});
