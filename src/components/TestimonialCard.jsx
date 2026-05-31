import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Quote } from 'lucide-react';

const TestimonialCard = ({ quote, author, role, organization }) => {
  return (
    <Card className="h-full transition-all duration-300 hover:shadow-lg">
      <CardContent className="p-6">
        <Quote className="w-8 h-8 text-primary/20 mb-4" />
        <blockquote className="text-foreground leading-relaxed mb-6">
          "{quote}"
        </blockquote>
        <div className="border-t border-border pt-4">
          <p className="font-semibold">{author}</p>
          <p className="text-sm text-muted-foreground">{role}</p>
          <p className="text-sm text-muted-foreground">{organization}</p>
        </div>
      </CardContent>
    </Card>
  );
};

export default TestimonialCard;
