import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/stores/auth.store';
import { useEventStore } from '@/stores/event.store';
import { Button } from '@/components/ui/button';
import { EventCard } from '@/components/events/EventCard';
import { EventForm } from '@/components/events/EventForm';
import { PlusIcon, SettingsIcon, BellIcon } from '@/components/icons';
import { useNavigate } from 'react-router-dom';
import type { Event, CreateEventRequest } from '@timemark/shared';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 }
};

export function Dashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { events, loading, fetchEvents, createEvent, updateEvent, deleteEvent } = useEventStore();
  const [showForm, setShowForm] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | undefined>();

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleSubmit = async (data: CreateEventRequest) => {
    if (editingEvent) {
      await updateEvent(editingEvent.id, data);
    } else {
      await createEvent(data);
    }
    setEditingEvent(undefined);
  };

  const handleEdit = (event: Event) => {
    setEditingEvent(event);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('确定删除此事件？')) {
      await deleteEvent(id);
      setShowForm(false);
      setEditingEvent(undefined);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50">
      <header className="bg-white/80 backdrop-blur-md border-b sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-xl font-semibold text-foreground">
            倒计时提醒系统
          </h1>
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/reminders')}>
              <BellIcon size={20} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => navigate('/settings')}>
              <SettingsIcon size={20} />
            </Button>
            <span className="text-sm text-muted-foreground">欢迎, {user?.username}</span>
            <Button variant="outline" onClick={logout}>退出</Button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-semibold text-foreground">我的事件</h2>
            <p className="text-sm text-muted-foreground mt-1">共 {events.length} 个事件</p>
          </div>
        </div>
        {loading ? (
          <div className="text-center py-20">
            <div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border">
            <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
              <PlusIcon size={32} />
            </div>
            <p className="text-muted-foreground">暂无事件，点击右下角按钮开始添加</p>
          </div>
        ) : (
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            {events.map((event) => (
              <motion.div key={event.id} variants={itemVariants}>
                <EventCard event={event} onEdit={handleEdit} onDelete={handleDelete} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>
      <motion.div
        className="fixed bottom-8 right-8 z-40"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
      >
        <Button
          size="lg"
          className="h-14 w-14 rounded-full shadow-lg"
          onClick={() => { setEditingEvent(undefined); setShowForm(true); }}
        >
          <PlusIcon size={24} />
        </Button>
      </motion.div>
      <EventForm
        open={showForm}
        onClose={() => { setShowForm(false); setEditingEvent(undefined); }}
        onSubmit={handleSubmit}
        event={editingEvent}
      />
    </div>
  );
}
