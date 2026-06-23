import { useState, useRef, useEffect, useMemo } from 'react';

export interface AutocompleteInputProps {
  value: string;
  options: string[];
  placeholder?: string;
  loading?: boolean;
  onChange: (value: string) => void;
}

/**
 * 自动补全输入框
 *
 * 输入时根据 options 本地过滤并显示匹配选项，支持键盘上下选择、回车确认、点击选择。
 */
export function AutocompleteInput({
  value,
  options,
  placeholder = '',
  loading = false,
  onChange,
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const raw = value.trim().toLowerCase();
    if (!raw) return options.slice(0, 10);
    return options
      .filter((o) => o.toLowerCase().includes(raw))
      .slice(0, 10);
  }, [value, options]);

  useEffect(() => {
    setHighlighted(0);
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlighted((prev) => (prev + 1) % filtered.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlighted((prev) => (prev - 1 + filtered.length) % filtered.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlighted]) {
          onChange(filtered[highlighted]);
          setOpen(false);
        }
        break;
      case 'Escape':
        setOpen(false);
        break;
    }
  };

  const handleSelect = (option: string) => {
    onChange(option);
    setOpen(false);
  };

  return (
    <div className="autocomplete" ref={containerRef}>
      <input
        className="input autocomplete-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {loading && open && (
        <div className="autocomplete-hint">加载中...</div>
      )}
      {open && !loading && filtered.length > 0 && (
        <div className="autocomplete-menu">
          {filtered.map((option, index) => (
            <div
              key={option}
              className={`autocomplete-item ${index === highlighted ? 'highlighted' : ''}`}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => handleSelect(option)}
            >
              {option}
            </div>
          ))}
        </div>
      )}
      {open && !loading && filtered.length === 0 && value.trim() && (
        <div className="autocomplete-menu">
          <div className="autocomplete-item disabled">无匹配项</div>
        </div>
      )}
    </div>
  );
}
