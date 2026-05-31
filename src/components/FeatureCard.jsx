import React from 'react';

const FeatureCard = ({ icon: Icon, title, description, variant = 'default' }) => {
  const variants = {
    default: 'bg-card shadow-lg rounded-2xl p-6',
    muted: 'bg-muted rounded-xl p-6',
    minimal: 'p-6'
  };

  return (
    <div className={`${variants[variant]} transition-all duration-300 hover:-translate-y-1`}>
      <div className="w-14 h-14 rounded-xl bg-secondary/10 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-secondary" />
      </div>
      <h3 className="text-xl font-semibold mb-3">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">
        {description}
      </p>
    </div>
  );
};

export default FeatureCard;
