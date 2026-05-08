/**
 * Typeahead customer search - searches both SAP companies.
 * Returns selected customer via onSelect.
 */
import { useState, useEffect, useRef } from 'react';
import { customersApi } from '../services/api.js';
import { Search, Loader2 } from 'lucide-react';

export default function CustomerSearchInput({ onSelect, placeholder = 'חפש לקוח...', companyFilter = 'ALL' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const debounceRef = useRef(null);
  const blurTimerRef = useRef(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const customers = await customersApi.search(query, companyFilter);
        setResults(customers);
      } catch (err) {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, companyFilter]);

  const handleSelect = (customer) => {
    setQuery(`${customer.CardCode} - ${customer.CardName}`);
    setOpen(false);
    onSelect(customer);
  };

  const handleKey = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(results[highlighted]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search size={16} className="absolute top-1/2 -translate-y-1/2 right-3 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlighted(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { blurTimerRef.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={handleKey}
          placeholder={placeholder}
          className="w-full pr-9 pl-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        {loading && (
          <Loader2 size={16} className="absolute top-1/2 -translate-y-1/2 left-3 text-gray-400 animate-spin" />
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full right-0 left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-auto z-10">
          {results.map((customer, idx) => (
            <button
              key={`${customer.CompanyCode}-${customer.CardCode}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); clearTimeout(blurTimerRef.current); handleSelect(customer); }}
              onMouseEnter={() => setHighlighted(idx)}
              className={`w-full text-right px-3 py-2 text-sm border-b border-gray-100 last:border-0
                ${idx === highlighted ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{customer.CardName}</span>
                <span className={`px-1.5 py-0.5 text-xs rounded ${customer.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                  {customer.CompanyCode}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                <span className="font-mono">{customer.CardCode}</span>
                {customer.City && <span className="mr-2">· {customer.City}</span>}
                {customer.Phone1 && <span className="mr-2">· {customer.Phone1}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && query.length >= 2 && !loading && results.length === 0 && (
        <div className="absolute top-full right-0 left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm text-gray-500 z-10">
          לא נמצאו לקוחות עבור "{query}"
        </div>
      )}
    </div>
  );
}
