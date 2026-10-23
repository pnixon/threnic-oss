import React from 'react';
import styles from './DropdownMenu.module.css';

// ── Panel ──────────────────────────────────────────────────────────────────────

interface DropdownPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const DropdownPanel = React.forwardRef<HTMLDivElement, DropdownPanelProps>(
  function DropdownPanel({ children, className, style, onClick, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={`${styles.panel} ${className ?? ''}`}
        style={style}
        onClick={onClick}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

// ── Item ───────────────────────────────────────────────────────────────────────

interface DropdownItemBaseProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

interface DropdownButtonItemProps extends DropdownItemBaseProps {
  href?: never;
}

interface DropdownLinkItemProps extends DropdownItemBaseProps {
  href: string;
  target?: string;
  rel?: string;
}

type DropdownItemProps = DropdownButtonItemProps | DropdownLinkItemProps;

export function DropdownItem({
  icon,
  children,
  danger,
  selected,
  onClick,
  ...rest
}: DropdownItemProps) {
  const className = `${styles.item} ${danger ? styles.itemDanger : ''} ${selected ? styles.itemSelected : ''}`;

  const content = (
    <>
      <div className={styles.itemMain}>
        {icon}
        {children}
      </div>
    </>
  );

  if ('href' in rest && rest.href) {
    const { href, target, rel } = rest as DropdownLinkItemProps;
    return (
      <a className={className} href={href} target={target} rel={rel} onClick={onClick}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────

export function DropdownHeader({ children }: { children: React.ReactNode }) {
  return <div className={styles.header}>{children}</div>;
}

// ── Divider ────────────────────────────────────────────────────────────────────

export function DropdownDivider() {
  return <div className={styles.divider} />;
}
