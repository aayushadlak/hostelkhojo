import datetime
import json
from sqlalchemy import Column, String, Float, Integer, Boolean, Text, DateTime, ForeignKey
try:
    from .database import Base
except ImportError:
    from database import Base

class UserDB(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=True)
    phone = Column(String, unique=True, index=True, nullable=True)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(String, default="student") # student, owner, admin
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class HostelDB(Base):
    __tablename__ = "hostels"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    university = Column(String, index=True, nullable=False)
    city = Column(String, index=True, nullable=False)
    gender = Column(String, nullable=False) # Co-ed, Girls, Boys
    type = Column(String, nullable=False)
    rent = Column(Float, nullable=False)
    deposit = Column(Float, nullable=False)
    distance = Column(Float, nullable=False)
    rating = Column(Float, default=4.8)
    reviews_count = Column(Integer, default=0)
    verified = Column(Boolean, default=True)
    featured = Column(Boolean, default=False)
    is_live = Column(Boolean, default=True)


    image_main = Column(String, nullable=True)
    image_single = Column(String, nullable=True)
    image_shared = Column(String, nullable=True)
    image_mess = Column(String, nullable=True)

    address = Column(Text, nullable=False)
    map_coords_json = Column(Text, default='{"top": 40, "left": 50}')
    amenities_json = Column(Text, default='[]')
    curfew = Column(String, default="11:00 PM")
    room_sharing_json = Column(Text, default='[]')
    description = Column(Text, nullable=False)
    mess_menu_json = Column(Text, default='{}')

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    owner_id = Column(String, ForeignKey("users.id"), nullable=True)

    # Helper getters/setters for JSON structures
    @property
    def amenities(self):
        if not self.amenities_json:
            return []
        try:
            val = json.loads(self.amenities_json)
            return val if isinstance(val, list) else []
        except Exception:
            return []

    @amenities.setter
    def amenities(self, value):
        self.amenities_json = json.dumps(value if value is not None else [])

    @property
    def room_sharing(self):
        if not self.room_sharing_json:
            return []
        try:
            val = json.loads(self.room_sharing_json)
            return val if isinstance(val, list) else []
        except Exception:
            return []

    @room_sharing.setter
    def room_sharing(self, value):
        self.room_sharing_json = json.dumps(value if value is not None else [])

    @property
    def mess_menu(self):
        if not self.mess_menu_json:
            return {}
        try:
            val = json.loads(self.mess_menu_json)
            return val if isinstance(val, dict) else {}
        except Exception:
            return {}

    @mess_menu.setter
    def mess_menu(self, value):
        self.mess_menu_json = json.dumps(value if value is not None else {})

    @property
    def map_coords(self):
        if not self.map_coords_json:
            return {"top": 40, "left": 50}
        try:
            val = json.loads(self.map_coords_json)
            return val if isinstance(val, dict) else {"top": 40, "left": 50}
        except Exception:
            return {"top": 40, "left": 50}

    @map_coords.setter
    def map_coords(self, value):
        self.map_coords_json = json.dumps(value if value is not None else {"top": 40, "left": 50})

class BookingDB(Base):
    __tablename__ = "bookings"

    id = Column(String, primary_key=True, index=True)
    hostel_id = Column(String, ForeignKey("hostels.id"), nullable=False)
    user_name = Column(String, nullable=True)
    phone = Column(String, nullable=False)
    visit_date = Column(String, nullable=False)
    room_sharing = Column(String, nullable=False)
    status = Column(String, default="Pending")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class RoommateDB(Base):
    __tablename__ = "roommates"

    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    gender = Column(String, nullable=False)
    university = Column(String, nullable=False)
    major = Column(String, nullable=False)
    budget = Column(Float, nullable=False)
    sleep_habit = Column(String, nullable=False) # Early Bird, Night Owl, Flexible
    diet = Column(String, nullable=False) # Pure Veg, Non-Veg, Eggitarian, Any
    bio = Column(Text, nullable=False)
    avatar = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class PropertySubmissionDB(Base):
    __tablename__ = "property_submissions"

    id = Column(String, primary_key=True, index=True)
    owner_name = Column(String, nullable=False)
    owner_phone = Column(String, nullable=False)
    property_name = Column(String, nullable=False)
    city = Column(String, nullable=False)
    address = Column(Text, nullable=False)
    rooms_count = Column(Integer, nullable=False)
    rent_range = Column(String, nullable=False)
    status = Column(String, default="Under Verification")
    owner_id = Column(String, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class ReviewDB(Base):
    __tablename__ = "reviews"

    id = Column(String, primary_key=True, index=True)
    hostel_id = Column(String, ForeignKey("hostels.id"), nullable=False)
    user_name = Column(String, nullable=False)
    major = Column(String, nullable=False)
    rating = Column(Float, nullable=False)
    comment = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class AdminNoticeDB(Base):
    __tablename__ = "admin_notices"

    id = Column(String, primary_key=True, index=True)
    owner_id = Column(String, index=True, nullable=False)
    property_id = Column(String, nullable=True)
    property_name = Column(String, nullable=False)
    message = Column(String, default="Admin has removed this property")
    reason = Column(String, nullable=True, default="Removed by Super Admin")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    is_dismissed = Column(Boolean, default=False)
