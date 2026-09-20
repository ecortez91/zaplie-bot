import React from 'react';
import RewardsComponent from './components/RewardsComponent';
import './App.css';

const Rewards: React.FC = () => {
  return (
    <div
      style={{
        background: 'var(--surface-page)',
        marginTop: 20,
        marginBottom: 40,
      }}
    >
      <div
        style={{
          paddingLeft: 'var(--space-4)',
          paddingRight: 'var(--space-4)',
          paddingBottom: 'var(--space-4)',
          paddingTop: 0,
        }}
      >
        <RewardsComponent userId={'2984e3ac627e4fea9fd6dde9c4df83b5'} />
      </div>
    </div>
  );
};

export default Rewards;
