import React from 'react';

const StatsMetric = ({ number, label, suffix = '' }) => {
  return (
    <div className="text-center">
      <div className="text-4xl md:text-5xl font-bold text-primary mb-2" style={{ letterSpacing: '-0.02em' }}>
        {number}{suffix}
      </div>
      <p className="text-sm text-muted-foreground font-medium tracking-wide uppercase">
        {label}
      </p>
    </div>
  );
};

export default StatsMetric;
