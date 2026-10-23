import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showToast, toast } from '@/utils/toast';

describe('toast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    // Mock requestAnimationFrame to execute its callback immediately
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('showToast', () => {
    it("should create a toast container if it doesn't exist", () => {
      showToast({ message: 'Test message' });
      const container = document.getElementById('threnic-toast-container');
      expect(container).not.toBeNull();
    });

    it('should add a toast element with the correct message', () => {
      showToast({ message: 'Hello World' });
      const container = document.getElementById('threnic-toast-container');
      expect(container?.textContent).toBe('Hello World');
    });

    it('should apply basic styles to the toast', () => {
      showToast({ message: 'Success', type: 'success' });
      const toastElement = document.querySelector('#threnic-toast-container div') as HTMLDivElement;

      // Check properties that were set in the second style update in showToast
      // (transform and opacity)
      expect(toastElement.style.transform).toBe('translateX(0)');
      expect(toastElement.style.opacity).toBe('1');
    });

    it('should automatically remove the toast after duration', () => {
      showToast({ message: 'Temporary', duration: 1000 });

      const container = document.getElementById('threnic-toast-container');
      expect(container?.children.length).toBe(1);

      // Fast-forward time
      vi.advanceTimersByTime(1000); // Trigger auto-dismiss
      vi.advanceTimersByTime(300); // Trigger removal after transition

      expect(container?.children.length).toBe(0);
    });
  });

  describe('toast convenience object', () => {
    it('should show info toast', () => {
      toast.info('Info message');
      const container = document.getElementById('threnic-toast-container');
      expect(container?.textContent).toBe('Info message');
    });

    it('should show success toast', () => {
      toast.success('Success message');
      const container = document.getElementById('threnic-toast-container');
      expect(container?.textContent).toBe('Success message');
    });

    it('should show warning toast', () => {
      toast.warning('Warning message');
      const container = document.getElementById('threnic-toast-container');
      expect(container?.textContent).toBe('Warning message');
    });

    it('should show error toast', () => {
      toast.error('Error message');
      const container = document.getElementById('threnic-toast-container');
      expect(container?.textContent).toBe('Error message');
    });
  });

  describe('container reuse', () => {
    it('should reuse existing container', () => {
      showToast({ message: 'First' });
      const firstContainer = document.getElementById('threnic-toast-container');

      showToast({ message: 'Second' });
      const secondContainer = document.getElementById('threnic-toast-container');

      expect(firstContainer).toBe(secondContainer);
      expect(secondContainer?.children.length).toBe(2);
    });
  });
});
