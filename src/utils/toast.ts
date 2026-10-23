/**
 * Toast notification system
 *
 * Simple CSS-only toast notifications that match the Cosmic Glassmorphism theme.
 * Uses direct DOM manipulation for zero-React-rerender notifications.
 */

/** Toast types for styling */
type ToastType = 'info' | 'success' | 'warning' | 'error';

/** Toast configuration */
interface ToastOptions {
  message: string | HTMLElement;
  type?: ToastType;
  duration?: number;
  dismissible?: boolean;
  onClick?: () => void;
  onDismiss?: () => void;
}

// Container element for toasts
let container: HTMLDivElement | null = null;

/**
 * Get or create the toast container
 */
function getContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) {
    return container;
  }

  container = document.createElement('div');
  container.id = 'threnic-toast-container';
  // On phones the bottom nav (~56px + safe-area) plus the compact player bar
  // (~120px) occupy the lower ~190px. Lift toasts above them so they never
  // overlap or intercept taps on the player bar / nav; keep the desktop offset
  // otherwise. Uses env(safe-area-inset-bottom) for notched devices.
  const isMobileViewport =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const bottomOffset = isMobileViewport ? 'calc(200px + env(safe-area-inset-bottom, 0px))' : '80px';
  container.style.cssText = `
    position: fixed;
    bottom: ${bottomOffset};
    right: 20px;
    left: ${isMobileViewport ? '20px' : 'auto'};
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  `;
  document.body.appendChild(container);
  return container;
}

/**
 * Get color for toast type
 */
function getTypeColor(type: ToastType): string {
  switch (type) {
    case 'success':
      return '#10b981'; // Green
    case 'warning':
      return '#f59e0b'; // Amber
    case 'error':
      return '#ef4444'; // Red
    case 'info':
    default:
      return '#ef4444'; // Red (theme accent)
  }
}

/**
 * Show a toast notification
 */
export function showToast(options: ToastOptions): void {
  const {
    message,
    type = 'info',
    duration = 4000,
    dismissible = false,
    onClick,
    onDismiss,
  } = options;

  const toast = document.createElement('div');
  const color = getTypeColor(type);

  toast.style.cssText = `
    padding: 12px 20px;
    background: rgba(18, 18, 20, 0.95);
    backdrop-filter: blur(12px);
    border: 1px solid ${color}40;
    border-left: 3px solid ${color};
    border-radius: 4px;
    color: #e0e0e0;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    max-width: 360px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
    transform: translateX(100%);
    opacity: 0;
    transition: transform 0.3s ease, opacity 0.3s ease;
    pointer-events: auto;
    position: relative;
    cursor: ${onClick || dismissible ? 'pointer' : 'default'};
  `;

  const contentDiv = document.createElement('div');
  if (typeof message === 'string') {
    contentDiv.textContent = message;
  } else {
    contentDiv.appendChild(message);
  }
  toast.appendChild(contentDiv);

  let isDismissed = false;
  const dismiss = () => {
    if (isDismissed) return;
    isDismissed = true;
    toast.style.transform = 'translateX(100%)';
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
      if (onDismiss) onDismiss();
    }, 300);
  };

  if (dismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
      position: absolute;
      top: 4px;
      right: 8px;
      background: none;
      border: none;
      color: #999;
      font-size: 18px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    `;
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      dismiss();
    };
    closeBtn.onmouseenter = () => (closeBtn.style.color = '#fff');
    closeBtn.onmouseleave = () => (closeBtn.style.color = '#999');
    toast.appendChild(closeBtn);

    // Add extra padding so text doesn't overlap button
    contentDiv.style.paddingRight = '16px';
  }

  if (onClick) {
    toast.onclick = onClick;
  } else if (dismissible) {
    toast.onclick = dismiss; // Clicking the toast also dismisses it if no explicit click handler
  }

  const container = getContainer();
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)';
    toast.style.opacity = '1';
  });

  // Auto-dismiss if duration > 0
  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

/**
 * Convenience methods
 */
export const toast = {
  info(
    message: string | HTMLElement,
    duration?: number,
    options?: Omit<ToastOptions, 'message' | 'type' | 'duration'>,
  ): void {
    showToast({ message, type: 'info', duration, ...options });
  },
  success(
    message: string | HTMLElement,
    duration?: number,
    options?: Omit<ToastOptions, 'message' | 'type' | 'duration'>,
  ): void {
    showToast({ message, type: 'success', duration, ...options });
  },
  warning(
    message: string | HTMLElement,
    duration?: number,
    options?: Omit<ToastOptions, 'message' | 'type' | 'duration'>,
  ): void {
    showToast({ message, type: 'warning', duration, ...options });
  },
  error(
    message: string | HTMLElement,
    duration?: number,
    options?: Omit<ToastOptions, 'message' | 'type' | 'duration'>,
  ): void {
    showToast({ message, type: 'error', duration, ...options });
  },
  show: showToast,
};
