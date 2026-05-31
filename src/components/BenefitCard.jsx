import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const BenefitCard = ({ icon: Icon, title, description, metric, index }) => {
  return (
    <Card className="h-full transition-all duration-300 hover:shadow-lg">
      <CardContent className="p-6 flex flex-col h-full">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Icon className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold mb-2">{title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {description}
            </p>
            {metric && (
              <Badge variant="secondary" className="font-semibold">
                {metric}
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default BenefitCard;
