import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the sample import screen', () => {
  render(<App />);
  expect(screen.getByText(/Drag & drop files \/ folders here/i)).toBeInTheDocument();
});
