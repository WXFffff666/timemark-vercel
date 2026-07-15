import { flushSync } from 'react-dom';

export function applyThemeClass(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark);
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Circular ripple theme transition (View Transitions API).
 * New theme expands from click coordinates; falls back to instant toggle.
 */
export async function toggleThemeWithTransition(
  nextDark: boolean,
  coords?: { x: number; y: number },
): Promise<void> {
  if (!document.startViewTransition || prefersReducedMotion()) {
    applyThemeClass(nextDark);
    return;
  }

  const x = coords?.x ?? window.innerWidth / 2;
  const y = coords?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  const direction = nextDark ? 'to-dark' : 'to-light';
  document.documentElement.dataset.themeTransition = direction;

  const clipKeyframes = [
    `circle(0px at ${x}px ${y}px)`,
    `circle(${endRadius}px at ${x}px ${y}px)`,
  ];
  const fullyOpenClip = `circle(${endRadius}px at ${x}px ${y}px)`;

  try {
    const transition = document.startViewTransition(() => {
      flushSync(() => {
        applyThemeClass(nextDark);
      });
    });

    await transition.ready;

    requestAnimationFrame(() => {
      document.documentElement.animate(
        { clipPath: clipKeyframes },
        {
          duration: 520,
          easing: 'ease-in-out',
          pseudoElement: '::view-transition-new(root)',
        },
      );
      document.documentElement.animate(
        { clipPath: [fullyOpenClip, fullyOpenClip] },
        {
          duration: 520,
          easing: 'ease-in-out',
          pseudoElement: '::view-transition-old(root)',
        },
      );
    });

    await transition.finished;
  } finally {
    delete document.documentElement.dataset.themeTransition;
  }
}
