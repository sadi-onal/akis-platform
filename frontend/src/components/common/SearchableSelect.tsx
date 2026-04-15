/**
 * SearchableSelect Component
 * A dropdown with search functionality, loading states, and manual override
 */
import { useState, useRef, useEffect, useMemo } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

interface SearchableSelectProps {
  label: string;
  placeholder?: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  onSearch?: (query: string) => void;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  disabled?: boolean;
  description?: string;
  allowManualInput?: boolean;
  manualInputPlaceholder?: string;
}

export default function SearchableSelect({
  label,
  placeholder = 'Seç...',
  options,
  value,
  onChange,
  onSearch,
  loading = false,
  error = null,
  emptyMessage = 'Secenek yok',
  disabled = false,
  description,
  allowManualInput = true,
  manualInputPlaceholder = 'Veya manuel olarak yazin...',
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isManualMode, setIsManualMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter options by search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;
    const query = searchQuery.toLowerCase();
    return options.filter(
      opt =>
        opt.label.toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query) ||
        opt.description?.toLowerCase().includes(query)
    );
  }, [options, searchQuery]);

  // Handle click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle search input
  useEffect(() => {
    if (onSearch && searchQuery) {
      onSearch(searchQuery);
    }
  }, [searchQuery, onSearch]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearchQuery('');
    setIsManualMode(false);
  };

  const handleManualInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const selectedOption = options.find(opt => opt.value === value);

  return (
    <div className="space-y-1" ref={containerRef}>
      <label className="block text-sm font-medium text-ak-text-primary">{label}</label>
      
      {/* Toggle between dropdown and manual input */}
      {allowManualInput && !disabled && (
        <div className="mb-1 flex gap-2">
          <button
            type="button"
            onClick={() => setIsManualMode(false)}
            className={`text-xs ${!isManualMode ? 'text-ak-primary font-medium' : 'text-ak-text-secondary hover:text-ak-primary'}`}
          >
            Select from list
          </button>
          <span className="text-ak-text-secondary/50">|</span>
          <button
            type="button"
            onClick={() => setIsManualMode(true)}
            className={`text-xs ${isManualMode ? 'text-ak-primary font-medium' : 'text-ak-text-secondary hover:text-ak-primary'}`}
          >
            Type manually
          </button>
        </div>
      )}

      {isManualMode ? (
        /* Manual Input Mode */
        <input
          type="text"
          value={value}
          onChange={handleManualInput}
          placeholder={manualInputPlaceholder}
          disabled={disabled}
          className="w-full rounded-lg border border-ak-border bg-ak-surface px-3 py-2 text-sm text-ak-text-primary placeholder-ak-text-secondary/50 focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary disabled:opacity-50"
        />
      ) : (
        /* Dropdown Mode */
        <div className="relative">
          <button
            type="button"
            onClick={() => !disabled && setIsOpen(!isOpen)}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${
              disabled
                ? 'cursor-not-allowed border-ak-border bg-ak-surface/50 opacity-50'
                : 'cursor-pointer border-ak-border bg-ak-surface hover:border-ak-primary'
            } ${error ? 'border-red-500' : ''}`}
          >
            <span className={selectedOption ? 'text-ak-text-primary' : 'text-ak-text-secondary/50'}>
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Yükleniyor...
                </span>
              ) : selectedOption ? (
                <span className="flex items-center gap-2">
                  {selectedOption.icon}
                  {selectedOption.label}
                </span>
              ) : (
                placeholder
              )}
            </span>
            <svg
              className={`h-4 w-4 text-ak-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Dropdown Panel - Liquid Glass Effect */}
          {isOpen && !loading && (
            <div 
              className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-ak-border/60 shadow-xl"
              style={{
                background: 'rgba(13, 23, 27, 0.95)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
              }}
            >
              {/* Search Input */}
              <div className="border-b border-ak-border/50 p-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Ara..."
                  aria-label="Secenekleri ara"
                  className="w-full rounded-lg border border-ak-border/50 bg-ak-bg/50 px-3 py-1.5 text-sm text-ak-text-primary placeholder-ak-text-secondary/50 focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/50"
                  autoFocus
                />
              </div>

              {/* Options List */}
              <div className="max-h-60 overflow-y-auto" role="listbox" aria-label={label}>
                {filteredOptions.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-ak-text-secondary">
                    {searchQuery ? 'Eslesme bulunamadi' : emptyMessage}
                  </div>
                ) : (
                  filteredOptions.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={option.value === value}
                      onClick={() => handleSelect(option.value)}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                        option.value === value
                          ? 'bg-ak-primary/15 text-ak-primary'
                          : 'text-ak-text-primary hover:bg-ak-surface-2/80'
                      }`}
                    >
                      {option.icon}
                      <div className="flex-1 overflow-hidden">
                        <div className="truncate font-medium">{option.label}</div>
                        {option.description && (
                          <div className="truncate text-xs text-ak-text-secondary">{option.description}</div>
                        )}
                      </div>
                      {option.value === value && (
                        <svg className="h-4 w-4 flex-shrink-0 text-ak-primary" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Description */}
      {description && <p className="text-xs text-ak-text-secondary">{description}</p>}

      {/* Error */}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

