import { useEffect, useState } from 'react';

interface ImageLightboxProps {
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

export function ImageLightbox({ images, index, onClose, onIndexChange }: ImageLightboxProps) {
  const [zoomed, setZoomed] = useState(false);

  const goPrev = () => onIndexChange((index - 1 + images.length) % images.length);
  const goNext = () => onIndexChange((index + 1) % images.length);

  // Zoom is per-image; navigating away from the current image should reset it.
  useEffect(() => {
    setZoomed(false);
  }, [index]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images.length]);

  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        &times;
      </button>

      <button
        className="lightbox-zoom"
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((z) => !z);
        }}
        aria-label={zoomed ? 'Zoom out' : 'Zoom to fit viewport'}
        aria-pressed={zoomed}
      >
        {zoomed ? '–' : '+'}
      </button>

      {images.length > 1 && (
        <button
          className="lightbox-nav lightbox-prev"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          aria-label="Previous image"
        >
          &#8249;
        </button>
      )}

      <img
        src={images[index]}
        alt=""
        className={`lightbox-image ${zoomed ? 'lightbox-image--zoomed' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((z) => !z);
        }}
      />

      {images.length > 1 && (
        <button
          className="lightbox-nav lightbox-next"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          aria-label="Next image"
        >
          &#8250;
        </button>
      )}

      {images.length > 1 && (
        <div className="lightbox-counter">
          {index + 1} / {images.length}
        </div>
      )}
    </div>
  );
}
