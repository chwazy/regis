import type { MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invokeCmd } from '../lib/ipc';
import styles from './Markdown.module.css';

function openExternal(event: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  event.preventDefault();
  if (href) {
    void invokeCmd<boolean>('open_external_url', { url: href }).catch(() => undefined);
  }
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} title={href} onClick={(event) => openExternal(event, href)}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  ),
  img: ({ alt, src }) => <span className={styles.image}>{alt || (typeof src === 'string' ? src : '')}</span>,
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `${styles.markdown} ${className}` : styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
