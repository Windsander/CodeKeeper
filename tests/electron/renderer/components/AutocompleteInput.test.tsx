/**
 * AutocompleteInput 组件测试
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutocompleteInput } from '../../../../src/electron/renderer/components/AutocompleteInput';

function StatefulAutocompleteInput({
  initialValue = '',
  options,
}: {
  initialValue?: string;
  options: string[];
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <AutocompleteInput
      value={value}
      options={options}
      onChange={(v) => setValue(v)}
    />
  );
}

describe('AutocompleteInput', () => {
  it('输入时显示匹配选项', () => {
    render(
      <StatefulAutocompleteInput options={['alice', 'arikan', 'bob']} />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'ar' } });

    expect(screen.getByText('arikan')).toBeTruthy();
    expect(screen.queryByText('bob')).toBeNull();
  });

  it('点击选项触发 onChange', () => {
    const onChange = vi.fn();
    render(
      <AutocompleteInput
        value=""
        options={['alice', 'arikan']}
        onChange={onChange}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('arikan'));

    expect(onChange).toHaveBeenCalledWith('arikan');
  });

  it('无匹配时显示无匹配项', () => {
    render(
      <StatefulAutocompleteInput options={['alice', 'bob']} />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'zzz' } });

    expect(screen.getByText('无匹配项')).toBeTruthy();
  });

  it('回车选择高亮项', () => {
    const onChange = vi.fn();
    render(
      <AutocompleteInput
        value=""
        options={['alice', 'arikan']}
        onChange={onChange}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('alice');
  });
});
