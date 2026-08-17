from pydantic import BaseModel
from typing import List, Optional, Dict
from datetime import datetime

# AUTH SCHEMAS
class UserRegister(BaseModel):
    full_name: str
    password: str
    email: Optional[str] = None
    phone: Optional[str] = None
    role: Optional[str] = "student"

class UserLogin(BaseModel):
    identifier: str # Email or Phone number
    password: str

class GoogleLogin(BaseModel):
    id_token: Optional[str] = None
    email: str
    full_name: str
    avatar: Optional[str] = None
    role: Optional[str] = "student"

class PhoneUpdate(BaseModel):
    user_id: str
    phone: str

class PasswordReset(BaseModel):
    identifier: str
    new_password: str

class UserRoleUpdate(BaseModel):
    role: str



class UserResponse(BaseModel):
    id: str
    full_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    role: str
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserResponse

# REVIEW SCHEMAS
class ReviewCreate(BaseModel):
    user_name: str
    major: str
    rating: float
    comment: str

class ReviewResponse(BaseModel):
    id: str
    hostel_id: str
    user_name: str
    major: str
    rating: float
    comment: str
    created_at: datetime

    class Config:
        from_attributes = True

# HOSTEL SCHEMAS
class MessMenuSchema(BaseModel):
    breakfast: Optional[str] = ""
    lunch: Optional[str] = ""
    snacks: Optional[str] = ""
    dinner: Optional[str] = ""

class MapCoordsSchema(BaseModel):
    top: float
    left: float

class HostelBase(BaseModel):
    name: str
    university: str
    city: str
    gender: str
    type: str
    rent: float
    deposit: float
    distance: float
    rating: float = 4.8
    reviewsCount: int = 0
    verified: bool = True
    featured: bool = False
    imageMain: Optional[str] = None
    imageSingle: Optional[str] = None
    imageShared: Optional[str] = None
    imageMess: Optional[str] = None
    address: str
    mapCoords: Optional[MapCoordsSchema] = MapCoordsSchema(top=40, left=50)
    amenities: List[str] = []
    curfew: str = "11:00 PM"
    roomSharing: List[str] = []
    description: str
    messMenu: Optional[MessMenuSchema] = MessMenuSchema()

class HostelCreate(HostelBase):
    pass

class HostelResponse(BaseModel):
    id: str
    name: str
    university: str
    city: str
    gender: str
    type: str
    rent: float
    deposit: float
    distance: float
    rating: float
    reviewsCount: int
    verified: bool
    featured: bool
    imageMain: Optional[str]
    imageSingle: Optional[str]
    imageShared: Optional[str]
    imageMess: Optional[str]
    address: str
    mapCoords: Dict[str, float]
    amenities: List[str]
    curfew: str
    roomSharing: List[str]
    description: str
    messMenu: Dict[str, str]
    owner_id: Optional[str] = None
    reviews: List[ReviewResponse] = []

    class Config:
        from_attributes = True

# BOOKING SCHEMAS
class BookingCreate(BaseModel):
    hostel_id: str
    user_name: Optional[str] = "Student Visitor"
    phone: str
    visit_date: str
    room_sharing: str

class BookingResponse(BaseModel):
    id: str
    hostel_id: str
    user_name: Optional[str]
    phone: str
    visit_date: str
    room_sharing: str
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

# ROOMMATE SCHEMAS
class RoommateCreate(BaseModel):
    name: str
    gender: str
    university: str
    major: str
    budget: float
    sleep_habit: str
    diet: str
    bio: str
    avatar: Optional[str] = None

class RoommateResponse(BaseModel):
    id: str
    name: str
    gender: str
    university: str
    major: str
    budget: float
    sleepHabit: str
    diet: str
    bio: str
    avatar: str

    class Config:
        from_attributes = True

# PROPERTY SUBMISSION SCHEMAS
class PropertySubmissionCreate(BaseModel):
    owner_name: str
    owner_phone: str
    property_name: str
    city: str
    address: str
    rooms_count: int
    rent_range: str

class PropertySubmissionResponse(BaseModel):
    id: str
    owner_name: str
    owner_phone: str
    property_name: str
    city: str
    address: str
    rooms_count: int
    rent_range: str
    status: str
    owner_id: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

class BookingStatusUpdate(BaseModel):
    status: str
